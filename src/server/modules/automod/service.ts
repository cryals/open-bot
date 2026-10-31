import { createHash, randomUUID } from 'node:crypto';
import type { ModuleContext } from '../../runtime/types.js';
import { CommunityStore } from '../../community-store.js';
import { TtlCounters } from '../../ttl-counters.js';
import { moderation } from '../moderation/index.js';
import { restPort, limitedResponse } from '../../module-http.js';
import { z } from 'zod';
import { sendBlocks } from '../../module-discord.js';
import { renderTemplate } from '../../template-context.js';
import { telemetry } from '../../telemetry.js';
import { HttpError } from '../../errors.js';
import { JobStore } from '../../jobs.js';
import { GuildAuthority } from '../../authority.js';
import { PermissionFlagsBits as P } from 'discord.js';
import type { APIMessage, APIGuildMember } from 'discord.js';
export type ObservedMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: { id: string; username: string; bot?: boolean; avatar?: string | null };
  content: string;
  member?: { roles: string[] };
  attachments: { filename: string; url: string }[];
  sticker_items?: unknown[];
  mentions?: unknown[];
  mention_roles?: string[];
  webhook_id?: string;
  edited_timestamp?: string | null;
};
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export class MessagePolicyService {
  private phishingDomains = new Set<string>();
  private phishingNextAt = 0;
  private configs: CommunityStore;
  constructor(
    private context: ModuleContext,
    readonly counters: TtlCounters,
  ) {
    this.configs = new CommunityStore(context.store);
  }
  private scope(
    rule: { channels: string[]; roles: string[]; exceptChannels: string[]; exceptRoles: string[] },
    message: ObservedMessage,
  ) {
    const roles = message.member?.roles || [];
    return (
      (!rule.channels.length || rule.channels.includes(message.channel_id)) &&
      (!rule.roles.length || rule.roles.some((id) => roles.includes(id))) &&
      !rule.exceptChannels.includes(message.channel_id) &&
      !rule.exceptRoles.some((id) => roles.includes(id))
    );
  }
  async process(message: ObservedMessage) {
    if (message.author.bot || message.webhook_id || message.guild_id !== this.context.config.guildId) return;
    const settings = this.configs.config('automod').document,
      slow = this.configs.config('slowmode').document,
      auto = this.configs.config('autoresponder').document;
    if (!settings.enabled && !slow.enabled && !auto.enabled) return;
    if (!(await this.counters.once('message:' + message.id + ':' + digest(message.content), 86400000)))
      return;
    let removed = false;
    if (settings.enabled) {
      const rules = [...settings.rules]
        .filter((rule) => rule.enabled && (!rule.native || rule.observe) && this.scope(rule, message))
        .sort((a, b) => b.priority - a.priority);
      for (const rule of rules) {
        if (!(await this.match(rule, message))) continue;
        const evidence = randomUUID(),
          now = Date.now();
        this.context.store.sqlite
          .prepare(
            'INSERT INTO automod_evidence(id,rule_id,user_id,channel_id,message_id,excerpt,explanation,action,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            evidence,
            rule.id,
            message.author.id,
            message.channel_id,
            message.id,
            message.content.slice(0, 500),
            `${rule.filter}: порог ${rule.threshold}`,
            rule.observe ? 'observe' : rule.action,
            now,
            now + settings.evidenceDays * 86400000,
          );
        if (!rule.observe) {
          if (rule.action !== 'notify' && rule.action !== 'review') {
            await this.remove(message);
            removed = true;
          }
          if (['warn', 'timeout', 'kick', 'ban'].includes(rule.action)) {
            const row = await moderation(this.context).enqueueSystem(
              {
                action: rule.action as 'warn' | 'timeout' | 'kick' | 'ban',
                target: message.author.id,
                reason: `AutoMod: ${rule.name} (${rule.id})`,
                duration: rule.action === 'timeout' ? rule.duration : null,
                deleteSeconds: 0,
              },
              `automod:${message.id}:${digest(message.content)}`,
              'automod:' + rule.id,
            );
            this.context.store.sqlite
              .prepare('UPDATE automod_evidence SET case_id=? WHERE id=?')
              .run(row.id, evidence);
          }
          if (rule.response)
            await sendBlocks(
              this.context.discord,
              this.context.store,
              message.channel_id,
              renderTemplate(rule.response, this.variables(message)),
              [],
              `automod-response:${message.id}:${rule.id}`,
            );
        }
        if (rule.eventChannel)
          await sendBlocks(
            this.context.discord,
            this.context.store,
            rule.eventChannel,
            [
              {
                id: 'decision',
                type: 'text',
                content: `## AutoMod · ${rule.name}\nУчастник: ${message.author.id}\nКанал: ${message.channel_id}\nФильтр: ${rule.filter}\nРешение: ${rule.observe ? 'наблюдение' : rule.action}\nСрабатывание: ${evidence}`,
              },
            ],
            rule.action === 'review'
              ? [
                  {
                    type: 1,
                    components: [
                      {
                        type: 2,
                        style: 4,
                        label: 'Подтвердить предупреждение',
                        custom_id: 'ob:am:warn:' + evidence,
                      },
                      { type: 2, style: 2, label: 'Отклонить', custom_id: 'ob:am:dismiss:' + evidence },
                    ],
                  },
                ]
              : [],
            `automod-evidence:${evidence}`,
          );
        telemetry.observe('automod', 'decision', rule.observe ? 'observed' : 'matched', now);
        break;
      }
    }
    if (!removed && slow.enabled)
      for (const rule of slow.rules) {
        if (
          rule.mode === 'discord' ||
          rule.channelId !== message.channel_id ||
          (rule.expiresAt && rule.expiresAt <= Date.now()) ||
          rule.exceptRoles.some((id) => message.member?.roles.includes(id))
        )
          continue;
        if (
          !(await this.counters.once(
            `slow:${rule.id}:${rule.mode === 'user' ? message.author.id : 'channel'}`,
            rule.seconds * 1000,
          ))
        ) {
          await this.remove(message);
          removed = true;
          break;
        }
      }
    if (removed || this.configs.state('anti-raid', 'incident')) return;
    if (auto.enabled) {
      const rule = [...auto.rules]
        .filter((rule) => rule.enabled && this.scope(rule, message))
        .sort((a, b) => (a.match === 'all' ? 1 : 0) - (b.match === 'all' ? 1 : 0) || b.priority - a.priority)
        .find(
          (rule) =>
            rule.match === 'all' ||
            (rule.match === 'exact'
              ? rule.caseSensitive
                ? message.content === rule.trigger
                : normalize(message.content) === normalize(rule.trigger)
              : rule.caseSensitive
                ? message.content.includes(rule.trigger)
                : normalize(message.content).includes(normalize(rule.trigger))),
        );
      if (rule) {
        if (
          rule.userCooldown &&
          !(await this.counters.once(`reply:${rule.id}:${message.author.id}`, rule.userCooldown * 1000))
        )
          return;
        if (
          rule.channelCooldown &&
          !(await this.counters.once(`reply:${rule.id}:${message.channel_id}`, rule.channelCooldown * 1000))
        )
          return;
        if (rule.blocks) {
          const id = await sendBlocks(
            this.context.discord,
            this.context.store,
            rule.destination || message.channel_id,
            renderTemplate(rule.blocks, this.variables(message)),
            [],
            `reply:${message.id}:${rule.id}`,
            undefined,
            undefined,
            rule.delivery,
          );
          if (rule.deleteAfter)
            new JobStore(this.context.store).enqueue(
              `delete:${id}`,
              'community.delete',
              message.id,
              { channel: rule.destination || message.channel_id, id },
              Date.now() + rule.deleteAfter * 1000,
            );
        }
        for (const emoji of rule.reactions)
          await restPort(this.context.discord).put(
            `/channels/${message.channel_id}/messages/${message.id}/reactions/${encodeURIComponent(emoji)}/@me`,
            { signal: AbortSignal.timeout(10000) },
          );
      }
    }
  }
  variables(message: ObservedMessage) {
    return {
      user: message.author.username,
      userId: message.author.id,
      avatar: message.author.avatar
        ? `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(message.author.id) >> 22n) % 6}.png`,
      guild: this.context.config.guildId,
      channel: message.channel_id,
    };
  }
  private async remove(message: ObservedMessage) {
    try {
      await restPort(this.context.discord).delete(`/channels/${message.channel_id}/messages/${message.id}`, {
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 10008) throw error;
    }
  }
  private async match(
    rule: import('zod').infer<typeof import('../../../shared/community.js').automodSchema>['rules'][number],
    message: ObservedMessage,
  ) {
    const text = normalize(message.content),
      words: string[] = text.match(/[\p{L}\p{N}_]+/gu) || [],
      urls = [...text.matchAll(/https?:\/\/[^\s<>]+/g)].map((match) => {
        try {
          return new URL(match[0]).hostname;
        } catch {
          return '';
        }
      });
    const contains = (values: string[]) =>
      values.some((value) =>
        rule.wholeWords
          ? new RegExp(
              '(^|[^\\p{L}\\p{N}_])' +
                normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                '($|[^\\p{L}\\p{N}_])',
              'u',
            ).test(text)
          : text.includes(normalize(value)),
      );
    const count = (delta = 1) =>
      this.counters.count(
        `${rule.filter}:${rule.id}:${message.author.id}:${message.channel_id}${rule.filter === 'duplicates' ? ':' + digest(text) : ''}`,
        rule.windowSeconds * 1000,
        delta,
      );
    switch (rule.filter) {
      case 'words':
        return contains(rule.values);
      case 'domains':
        return urls.some(
          (host) =>
            !rule.allowlist.some(
              (value) => host === normalize(value) || host.endsWith('.' + normalize(value)),
            ) &&
            (!rule.values.length ||
              rule.values.some(
                (value) => host === normalize(value) || host.endsWith('.' + normalize(value)),
              )),
        );
      case 'phishing':
        return urls.some(
          (host) =>
            this.phishingDomains.has(host) ||
            this.configs.config('automod').document.phishingDomains.includes(host),
        );
      case 'invites':
        return (
          /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i.test(text) &&
          !rule.allowlist.some((value) => text.includes(normalize(value)))
        );
      case 'rate':
      case 'duplicates':
        return (await count()) > rule.threshold;
      case 'repeated-chars':
        return (text.match(/(.)\1{2,}/gu) || []).some((value) => value.length >= rule.threshold);
      case 'repeated-words': {
        const counts = new Map<string, number>();
        for (const word of words) {
          const count = (counts.get(word) || 0) + 1;
          if (count >= rule.threshold) return true;
          counts.set(word, count);
        }
        return false;
      }
      case 'caps': {
        const letters = message.content.match(/\p{L}/gu) || [];
        return (
          letters.length >= rule.minLength &&
          (letters.filter(
            (letter) => letter === letter.toLocaleUpperCase() && letter !== letter.toLocaleLowerCase(),
          ).length /
            letters.length) *
            100 >=
            rule.threshold
        );
      }
      case 'mentions':
        return (
          (await count((message.mentions?.length || 0) + (message.mention_roles?.length || 0))) >=
            rule.threshold || /@(?:everyone|here)/.test(text)
        );
      case 'emoji':
        return (
          (await count((text.match(/<a?:\w+:\d+>|\p{Extended_Pictographic}/gu) || []).length)) >=
          rule.threshold
        );
      case 'attachments':
        return (await count(message.attachments.length)) >= rule.threshold;
      case 'stickers':
        return (await count(message.sticker_items?.length || 0)) >= rule.threshold;
      case 'length':
        return message.content.length > rule.threshold;
      case 'lines':
        return message.content.split('\n').length > rule.threshold;
      case 'spoilers':
        return (text.match(/\|\|/g) || []).length / 2 >= rule.threshold;
      case 'zalgo':
        return (text.match(/\p{M}/gu) || []).length >= rule.threshold;
      case 'files':
        return message.attachments.some((file) =>
          rule.values.some((value) =>
            file.filename.toLowerCase().endsWith('.' + value.toLowerCase().replace(/^\./, '')),
          ),
        );
      case 'media-only':
        return !message.attachments.length && !/https?:\/\//.test(text);
      case 'youtube-only':
        return !/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be)\//.test(text);
      case 'honeypot':
        return true;
    }
  }
  async review(id: string, actor: string, approve: boolean) {
    const { requireCapability } = await import('../../access.js');
    await requireCapability(
      this.context.discord,
      this.context.store,
      this.context.config,
      actor,
      'moderationManage',
    );
    const row = this.context.store.sqlite
      .prepare('SELECT * FROM automod_evidence WHERE id=? AND expires_at>?')
      .get(id, Date.now()) as { user_id: string; rule_id: string; reviewed_by: string | null } | undefined;
    if (!row || row.reviewed_by) throw new HttpError(409, 'Срабатывание истекло или обработано');
    if (approve) {
      await new GuildAuthority(this.context.config, this.context.discord, this.context.store).action(
        actor,
        row.user_id,
        P.ModerateMembers,
        moderation(this.context).settings().document.protectedRoles,
      );
      const result = await moderation(this.context).enqueueSystem(
        {
          action: 'warn',
          target: row.user_id,
          reason: `Подтверждено ${actor}: AutoMod ${row.rule_id}`,
          duration: null,
          deleteSeconds: 0,
        },
        `review:${id}`,
        'automod-review',
      );
      this.context.store.sqlite
        .prepare('UPDATE automod_evidence SET case_id=? WHERE id=?')
        .run(result.id, id);
    }
    this.context.store.sqlite.prepare('UPDATE automod_evidence SET reviewed_by=? WHERE id=?').run(actor, id);
  }
  async raw(data: Record<string, unknown>) {
    const config = this.configs.config('automod').document;
    if (!config.enabled) return;
    const native = this.configs.state<Record<string, string>>('automod', 'native') || {},
      rule = config.rules.find((item) => item.enabled && item.native && native[item.id] === data.rule_id);
    if (
      !rule ||
      !['warn', 'timeout', 'kick', 'ban'].includes(rule.action) ||
      rule.observe ||
      typeof data.user_id !== 'string'
    )
      return;
    const key = String(data.message_id || data.alert_system_message_id || digest(JSON.stringify(data)));
    await moderation(this.context).enqueueSystem(
      {
        action: rule.action as 'warn' | 'timeout' | 'kick' | 'ban',
        target: data.user_id,
        reason: `Native AutoMod: ${rule.name}`,
        duration: rule.action === 'timeout' ? rule.duration : null,
        deleteSeconds: 0,
      },
      `native:${key}:${rule.id}`,
      'native-automod',
    );
  }
  async syncNative() {
    const { PermissionFlagsBits } = await import('discord.js'),
      { GuildAuthority } = await import('../../authority.js');
    const auth = await new GuildAuthority(this.context.config, this.context.discord, this.context.store).load(
      this.context.config.clientId,
    );
    if (!auth.has(auth.bot, PermissionFlagsBits.ManageGuild))
      throw new HttpError(403, 'Нужно Manage Server для Native AutoMod');
    const settings = this.configs.config('automod').document,
      mapping = this.configs.state<Record<string, string>>('automod', 'native') || {},
      rest = restPort(this.context.discord);
    for (const rule of settings.rules) {
      if (!rule.native) continue;
      if (rule.roles.length)
        throw new HttpError(
          400,
          'Native AutoMod не поддерживает ограничение только выбранными ролями; используйте режим бота',
        );
      const exempt = [
        ...new Set([
          ...rule.exceptChannels,
          ...(rule.channels.length
            ? (await this.context.discord.info()).channels
                .filter((channel) => !rule.channels.includes(channel.id))
                .map((channel) => channel.id)
            : []),
        ]),
      ];
      if (exempt.length > 50 || rule.exceptRoles.length > 20)
        throw new HttpError(400, 'Превышены ограничения исключений Native AutoMod; используйте режим бота');
      if (!['words', 'invites', 'mentions'].includes(rule.filter))
        throw new HttpError(400, 'Native поддерживает words, invites и mentions');
      const body = {
        name: 'Open Bot: ' + rule.name,
        event_type: 1,
        trigger_type: rule.filter === 'mentions' ? 5 : 1,
        trigger_metadata:
          rule.filter === 'mentions'
            ? { mention_total_limit: Math.min(50, rule.threshold) }
            : {
                keyword_filter:
                  rule.filter === 'invites' ? ['*discord.gg/*', '*discord.com/invite/*'] : rule.values,
              },
        actions: [{ type: 1, metadata: { custom_message: 'Сообщение заблокировано правилом сервера' } }],
        enabled: settings.enabled && rule.enabled && !rule.observe,
        exempt_roles: rule.exceptRoles,
        exempt_channels: exempt,
      };
      const result = (await rest[mapping[rule.id] ? 'patch' : 'post'](
        `/guilds/${this.context.config.guildId}/auto-moderation/rules${mapping[rule.id] ? '/' + mapping[rule.id] : ''}`,
        { body, signal: AbortSignal.timeout(10000) },
      )) as { id: string };
      mapping[rule.id] = result.id;
      this.configs.set('automod', 'native', mapping);
    }
    for (const [id, nativeId] of Object.entries(mapping))
      if (!settings.rules.some((rule) => rule.id === id && rule.native)) {
        await rest.delete(`/guilds/${this.context.config.guildId}/auto-moderation/rules/${nativeId}`, {
          signal: AbortSignal.timeout(10000),
        });
        delete mapping[id];
        this.configs.set('automod', 'native', mapping);
      }
  }
  async refreshPhishing() {
    const config = this.configs.config('automod').document;
    if (!config.enabled || config.phishingSource === 'none' || Date.now() < this.phishingNextAt) return;
    const saved = this.configs.state<{ domains: string[]; updatedAt: number }>('automod', 'phishing-feed');
    if (saved && !this.phishingDomains.size) this.phishingDomains = new Set(saved.domains);
    this.phishingNextAt = Date.now() + 900000;
    try {
      const dt = saved ? Math.ceil((Date.now() - saved.updatedAt) / 1000) + 60 : 0,
        full = !saved || dt > 604800;
      const response = await fetch(
        'https://phish.sinking.yachts/v2/' + (full ? 'all' : 'recent/' + Math.max(1, dt)),
        {
          headers: { 'X-Identity': 'Open Bot (github.com/cryals/open-bot)' },
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok) throw new Error('Phishing source HTTP ' + response.status);
      const data = JSON.parse(await limitedResponse(response, 8 * 1024 * 1024));
      if (full) this.phishingDomains = new Set(z.array(z.string().max(253)).max(500000).parse(data));
      else
        for (const change of z
          .array(z.object({ type: z.enum(['add', 'delete']), domains: z.array(z.string().max(253)) }))
          .parse(data))
          for (const domain of change.domains)
            if (change.type === 'add') this.phishingDomains.add(domain);
            else this.phishingDomains.delete(domain);
      this.configs.set('automod', 'phishing-feed', {
        domains: [...this.phishingDomains],
        updatedAt: Date.now(),
      });
    } catch (error) {
      this.phishingNextAt = Date.now() + 3600000;
      this.context.errors.report(error, 'automod.phishing-refresh');
    }
  }
}
export async function completeMessage(
  context: ModuleContext,
  data: Record<string, unknown>,
): Promise<ObservedMessage> {
  if (data.author && typeof data.content === 'string') return data as unknown as ObservedMessage;
  const response = (await restPort(context.discord).get(`/channels/${data.channel_id}/messages/${data.id}`, {
    signal: AbortSignal.timeout(10000),
  })) as APIMessage;
  const member = (await restPort(context.discord).get(
    `/guilds/${context.config.guildId}/members/${response.author.id}`,
    { signal: AbortSignal.timeout(10000) },
  )) as APIGuildMember;
  return { ...response, guild_id: context.config.guildId, member } as ObservedMessage;
}
