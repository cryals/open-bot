import { PermissionFlagsBits as P, type APIGuildMember } from 'discord.js';
import type { ModuleContext } from '../../runtime/types.js';
import { CommunityStore } from '../../community-store.js';
import { TtlCounters } from '../../ttl-counters.js';
import { JobStore } from '../../jobs.js';
import { restPort } from '../../module-http.js';
import { GuildAuthority } from '../../authority.js';
import { moderation } from '../moderation/index.js';
import { sendBlocks } from '../../module-discord.js';
type Incident = {
  id: string;
  started: number;
  lastJoin: number;
  reason: string;
  members: string[];
  channels: { id: string; before: number; applied: number }[];
  quarantined: string[];
  locks: number[];
  quarantineRole?: string | null;
};
export class JoinPolicyService {
  private configs: CommunityStore;
  private authority: GuildAuthority;
  constructor(
    private context: ModuleContext,
    private counters: TtlCounters,
  ) {
    this.configs = new CommunityStore(context.store);
    this.authority = new GuildAuthority(context.config, context.discord, context.store);
  }
  join(data: Record<string, unknown>) {
    if (data.guild_id !== this.context.config.guildId || !data.user || typeof data.user !== 'object') return;
    const user = data.user as { id: string; username: string; bot?: boolean };
    if (user.bot) return;
    if (
      !this.configs.config('autoban').document.enabled &&
      !this.configs.config('anti-raid').document.enabled &&
      !this.configs.state('anti-raid', 'incident')
    )
      return;
    const joined = String(data.joined_at || '');
    new JobStore(this.context.store).enqueue(`join:${user.id}:${joined}`, 'community.join', user.id, {
      user,
      roles: data.roles || [],
      joined,
    });
  }
  async process(input: { user: { id: string; username: string }; roles: string[]; joined?: string }) {
    const settings = this.configs.config('anti-raid').document;
    const created = Number((BigInt(input.user.id) >> 22n) + 1420070400000n),
      age = (Date.now() - created) / 1000;
    let incident = this.configs.state<Incident>('anti-raid', 'incident');
    if (settings.enabled && !settings.exceptRoles.some((role) => input.roles.includes(role))) {
      const count = await this.counters.count('joins', settings.windowSeconds * 1000);
      if (
        !incident &&
        count >= settings.threshold &&
        (settings.youngAccountSeconds === 0 || age < settings.youngAccountSeconds)
      )
        incident = await this.start('Порог входов: ' + count);
      if (incident) {
        incident.lastJoin = Date.now();
        if (!incident.members.includes(input.user.id)) incident.members.push(input.user.id);
        incident.members = incident.members.slice(-10000);
        this.configs.set('anti-raid', 'incident', incident);
        if (settings.automatic) {
          if (settings.action === 'quarantine' && settings.quarantineRole) {
            await this.authority.safeRole(
              this.context.config.clientId,
              input.user.id,
              settings.quarantineRole,
              [settings.quarantineRole],
              true,
            );
            incident.quarantined.push(input.user.id);
            this.configs.set('anti-raid', 'incident', incident);
          } else if (['timeout', 'kick', 'ban'].includes(settings.action))
            await moderation(this.context).enqueueSystem(
              {
                action: settings.action as 'timeout' | 'kick' | 'ban',
                target: input.user.id,
                reason: `AntiRaid ${incident.id}`,
                duration: settings.action === 'timeout' ? settings.quietSeconds : null,
                deleteSeconds: 0,
              },
              `raid:${incident.id}:${input.user.id}`,
              'anti-raid',
            );
        }
        return;
      }
    }
    const autoban = this.configs.config('autoban').document;
    if (!autoban.enabled) return;
    for (const rule of autoban.rules) {
      if (
        !rule.enabled ||
        rule.exceptUsers.includes(input.user.id) ||
        rule.exceptRoles.some((role) => input.roles.includes(role))
      )
        continue;
      const name = rule.caseSensitive
          ? input.user.username
          : input.user.username.normalize('NFKC').toLocaleLowerCase(),
        value = rule.caseSensitive ? rule.value : rule.value.normalize('NFKC').toLocaleLowerCase();
      const match =
        rule.filter === 'account-age'
          ? age < rule.seconds
          : rule.filter === 'name-invite'
            ? /(?:discord\.gg|discord(?:app)?\.com\/invite)\//i.test(name)
            : rule.match === 'all' || (rule.match === 'exact' ? name === value : name.includes(value));
      if (!match) continue;
      this.configs.set('autoban', 'decision:' + input.user.id, {
        rule: rule.id,
        observe: rule.observe,
        time: Date.now(),
      });
      if (!rule.observe)
        await moderation(this.context).enqueueSystem(
          {
            action: rule.action,
            target: input.user.id,
            reason: 'AutoBan: ' + rule.id,
            duration: rule.action === 'timeout' ? rule.duration : null,
            deleteSeconds: 0,
          },
          `autoban:${input.user.id}:${rule.id}:${input.joined || new Date().toISOString().slice(0, 10)}`,
          'autoban',
        );
      break;
    }
  }
  async start(reason: string) {
    const existing = this.configs.state<Incident>('anti-raid', 'incident');
    if (existing) return existing;
    const config = this.configs.config('anti-raid').document;
    const incident: Incident = {
      id: crypto.randomUUID(),
      started: Date.now(),
      lastJoin: Date.now(),
      reason,
      members: [],
      channels: [],
      quarantined: [],
      locks: [],
      quarantineRole: config.quarantineRole,
    };
    this.configs.set('anti-raid', 'incident', incident);
    if (config.automatic)
      for (const id of config.channels) {
        const { channel } = await this.authority.channel(this.context.config.clientId, id, P.ManageChannels);
        if ('rate_limit_per_user' in channel) {
          incident.channels.push({
            id,
            before: channel.rate_limit_per_user || 0,
            applied: config.slowmodeSeconds,
          });
          this.configs.set('anti-raid', 'incident', incident);
          await restPort(this.context.discord).patch(`/channels/${id}`, {
            body: { rate_limit_per_user: config.slowmodeSeconds },
            signal: AbortSignal.timeout(10000),
          });
        }
        if (config.lockdown) {
          const row = await moderation(this.context).enqueueSystem(
            {
              action: 'lock',
              target: id,
              reason: 'AntiRaid ' + incident.id,
              duration: null,
              deleteSeconds: 0,
            },
            `raid-lock:${incident.id}:${id}`,
            'anti-raid',
          );
          incident.locks.push(row.id);
          this.configs.set('anti-raid', 'incident', incident);
        }
      }
    if (config.eventChannel)
      await sendBlocks(
        this.context.discord,
        this.context.store,
        config.eventChannel,
        [
          {
            id: 'raid',
            type: 'text',
            content: `## Защитный режим включён\n${reason}\nИнцидент: ${incident.id}`,
          },
        ],
        [],
        `raid-start:${incident.id}`,
      );
    return incident;
  }
  async stop(reason: string) {
    const incident = this.configs.state<Incident>('anti-raid', 'incident');
    if (!incident) return;
    const config = this.configs.config('anti-raid').document,
      rest = restPort(this.context.discord);
    for (const saved of incident.channels) {
      const channel = (await rest.get(`/channels/${saved.id}`, { signal: AbortSignal.timeout(10000) })) as {
        rate_limit_per_user?: number;
      };
      if (channel.rate_limit_per_user === saved.applied)
        await rest.patch(`/channels/${saved.id}`, {
          body: { rate_limit_per_user: saved.before },
          signal: AbortSignal.timeout(10000),
        });
    }
    for (const id of incident.quarantined)
      if (incident.quarantineRole) {
        try {
          await this.authority.safeRole(
            this.context.config.clientId,
            id,
            incident.quarantineRole,
            [incident.quarantineRole],
            false,
          );
        } catch (error) {
          if ((error as { code?: number }).code !== 10007) throw error;
        }
      }
    for (const id of incident.locks) {
      const row = moderation(this.context).get(id);
      if (row.state === 'applied')
        await moderation(this.context).enqueueSystem(
          {
            action: 'unlock',
            target: row.target,
            reason: 'Окончание AntiRaid ' + incident.id,
            duration: null,
            deleteSeconds: 0,
          },
          `raid-unlock:${incident.id}:${row.target}`,
          'anti-raid',
        );
    }
    this.configs.set('anti-raid', 'history:' + incident.id, {
      ...incident,
      ended: Date.now(),
      endReason: reason,
    });
    this.context.store.sqlite
      .prepare("DELETE FROM module_state WHERE module='anti-raid' AND key='incident'")
      .run();
    if (config.eventChannel)
      await sendBlocks(
        this.context.discord,
        this.context.store,
        config.eventChannel,
        [
          {
            id: 'raid-end',
            type: 'text',
            content: `## Защитный режим завершён\n${reason}\nУчастников: ${incident.members.length}`,
          },
        ],
        [],
        `raid-end:${incident.id}`,
      );
  }
  async tick() {
    const config = this.configs.config('anti-raid').document,
      incident = this.configs.state<Incident>('anti-raid', 'incident');
    if (incident && Date.now() - incident.lastJoin >= config.quietSeconds * 1000)
      await this.stop('Окно тишины');
    await this.slowmode();
  }
  async slowmode() {
    const settings = this.configs.config('slowmode'),
      state =
        this.configs.state<Record<string, { before: number; applied: number; channel: string }>>(
          'slowmode',
          'applied',
        ) || {},
      rest = restPort(this.context.discord);
    for (const rule of settings.document.rules) {
      if (
        !settings.document.enabled ||
        rule.mode !== 'discord' ||
        (rule.expiresAt && rule.expiresAt <= Date.now())
      )
        continue;
      if (state[rule.id]?.applied === rule.seconds && state[rule.id]?.channel === rule.channelId) continue;
      const { channel } = await this.authority.channel(
        this.context.config.clientId,
        rule.channelId,
        P.ManageChannels,
      );
      if (!('rate_limit_per_user' in channel)) continue;
      state[rule.id] = {
        before: state[rule.id]?.before ?? channel.rate_limit_per_user ?? 0,
        applied: rule.seconds,
        channel: rule.channelId,
      };
      this.configs.set('slowmode', 'applied', state);
      await rest.patch(`/channels/${rule.channelId}`, {
        body: { rate_limit_per_user: rule.seconds },
        signal: AbortSignal.timeout(10000),
      });
    }
    for (const [id, saved] of Object.entries(state)) {
      if (
        settings.document.enabled &&
        settings.document.rules.some(
          (rule) =>
            rule.id === id && rule.mode === 'discord' && (!rule.expiresAt || rule.expiresAt > Date.now()),
        )
      )
        continue;
      const channel = (await rest.get(`/channels/${saved.channel}`, {
        signal: AbortSignal.timeout(10000),
      })) as { rate_limit_per_user?: number };
      if (channel.rate_limit_per_user === saved.applied)
        await rest.patch(`/channels/${saved.channel}`, {
          body: { rate_limit_per_user: saved.before },
          signal: AbortSignal.timeout(10000),
        });
      delete state[id];
      this.configs.set('slowmode', 'applied', state);
    }
  }
}
export async function currentMember(context: ModuleContext, user: string) {
  return (await restPort(context.discord).get(`/guilds/${context.config.guildId}/members/${user}`, {
    signal: AbortSignal.timeout(10000),
  })) as APIGuildMember;
}
