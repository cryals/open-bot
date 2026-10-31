import { randomInt, randomUUID } from 'node:crypto';
import { PermissionFlagsBits as P } from 'discord.js';
import { giveawaySchema } from '../../../shared/community.js';
import type { ModuleContext } from '../../runtime/types.js';
import { CommunityStore } from '../../community-store.js';
import { currentMember } from '../anti-raid/service.js';
import { HttpError } from '../../errors.js';
import { sendBlocks } from '../../module-discord.js';
import { GuildAuthority } from '../../authority.js';
import { restPort } from '../../module-http.js';
type Definition = import('zod').infer<typeof giveawaySchema>;
export type Giveaway = {
  id: string;
  document: string;
  state: string;
  version: number;
  message_id: string | null;
  actor: string;
  results: string;
  delivery_state: string;
  reason: string | null;
  created_at: number;
};
export class GiveawayService {
  private configs: CommunityStore;
  private busy = false;
  constructor(private context: ModuleContext) {
    this.configs = new CommunityStore(context.store);
  }
  list() {
    return this.context.store.sqlite
      .prepare('SELECT * FROM giveaways ORDER BY created_at DESC LIMIT 100')
      .all() as Giveaway[];
  }
  get(id: string) {
    const row = this.context.store.sqlite.prepare('SELECT * FROM giveaways WHERE id=?').get(id) as
      Giveaway | undefined;
    if (!row) throw new HttpError(404, 'Розыгрыш не найден');
    return row;
  }
  async create(document: unknown, actor: string) {
    if (!this.configs.config('giveaways').document.enabled) throw new HttpError(409, 'Розыгрыши выключены');
    const parsed = giveawaySchema.parse(document);
    const authority = new GuildAuthority(this.context.config, this.context.discord, this.context.store);
    const { auth } = await authority.channel(actor, parsed.channelId, P.ViewChannel | P.SendMessages);
    if (parsed.rewardRole) authority.validatePublicRoles(auth, [parsed.rewardRole], [parsed.rewardRole]);
    if (parsed.endsAt <= Date.now()) throw new HttpError(400, 'Укажите дату окончания в будущем');
    const id = randomUUID();
    this.context.store.sqlite
      .prepare("INSERT INTO giveaways(id,document,state,actor,created_at) VALUES(?,?,'scheduled',?,?)")
      .run(id, JSON.stringify(parsed), actor, Date.now());
    return this.get(id);
  }
  async entry(id: string, user: string, join: boolean, referrer?: string) {
    const row = this.get(id),
      definition = giveawaySchema.parse(JSON.parse(row.document));
    if (row.state !== 'open' || Date.now() < definition.startsAt || Date.now() >= definition.endsAt)
      throw new HttpError(409, 'Приём участников закрыт');
    const member = await currentMember(this.context, user);
    this.eligible(definition, user, member.roles);
    this.context.store.sqlite
      .transaction(() => {
        const current = this.get(id);
        if (current.state !== 'open' || current.version !== row.version || Date.now() >= definition.endsAt)
          throw new HttpError(409, 'Приём участников закрыт или условия изменены');
        if (!join) {
          this.context.store.sqlite
            .prepare('DELETE FROM giveaway_entries WHERE giveaway_id=? AND user_id=?')
            .run(id, user);
          return;
        }
        const day = new Date().toISOString().slice(0, 10),
          existing = this.context.store.sqlite
            .prepare('SELECT last_bonus FROM giveaway_entries WHERE giveaway_id=? AND user_id=?')
            .get(id, user) as { last_bonus: string | null } | undefined;
        if (existing) {
          if (existing.last_bonus !== day && definition.dailyBonus)
            this.context.store.sqlite
              .prepare(
                'UPDATE giveaway_entries SET chances=min(?,chances+?),last_bonus=? WHERE giveaway_id=? AND user_id=?',
              )
              .run(definition.maxChances, definition.dailyBonus, day, id, user);
          return;
        }
        const validRef =
          referrer &&
          referrer !== user &&
          this.context.store.sqlite
            .prepare('SELECT 1 FROM giveaway_entries WHERE giveaway_id=? AND user_id=?')
            .get(id, referrer)
            ? referrer
            : null;
        this.context.store.sqlite
          .prepare(
            'INSERT INTO giveaway_entries(giveaway_id,user_id,referrer,last_bonus,created_at) VALUES(?,?,?,?,?)',
          )
          .run(id, user, validRef, day, Date.now());
        if (validRef && definition.referralBonus)
          this.context.store.sqlite
            .prepare('UPDATE giveaway_entries SET chances=min(?,chances+?) WHERE giveaway_id=? AND user_id=?')
            .run(definition.maxChances, definition.referralBonus, id, validRef);
      })
      .immediate();
  }
  private eligible(definition: Definition, user: string, roles: string[]) {
    if (
      definition.requiredRoles.some((role) => !roles.includes(role)) ||
      definition.blockedRoles.some((role) => roles.includes(role)) ||
      Date.now() - Number((BigInt(user) >> 22n) + 1420070400000n) < definition.minAccountDays * 86400000
    )
      throw new HttpError(403, 'Не выполнены условия участия');
  }
  async end(id: string, actor: string, reason: string, reroll = false) {
    const row = this.get(id),
      definition = giveawaySchema.parse(JSON.parse(row.document));
    if (reroll ? row.state !== 'ended' : !['open', 'scheduled', 'drawing'].includes(row.state))
      throw new HttpError(409, 'Розыгрыш недоступен для завершения');
    const saved = this.configs.state<{ actor: string; reason: string; reroll: boolean }>(
      'giveaways',
      'draw:' + id,
    );
    if (row.state === 'drawing' && saved) {
      actor = saved.actor;
      reason = saved.reason;
      reroll = saved.reroll;
    } else this.configs.set('giveaways', 'draw:' + id, { actor, reason, reroll });
    // Persist drawing state before asynchronous member checks. A crash resumes the same draw.
    if (
      !this.context.store.sqlite
        .prepare("UPDATE giveaways SET state='drawing' WHERE id=? AND version=? AND state=?")
        .run(id, row.version, row.state).changes
    )
      throw new HttpError(409, 'Розыгрыш изменён');
    const excluded = new Set<string>(
      reroll
        ? this.context.store.sqlite
            .prepare('SELECT result FROM giveaway_history WHERE giveaway_id=?')
            .all(id)
            .flatMap((item) => JSON.parse((item as { result: string }).result) as string[])
        : [],
    );
    const entries = this.context.store.sqlite
      .prepare('SELECT user_id,chances FROM giveaway_entries WHERE giveaway_id=? ORDER BY user_id')
      .all(id) as { user_id: string; chances: number }[];
    const eligible: typeof entries = [];
    for (const entry of entries) {
      if (excluded.has(entry.user_id)) continue;
      try {
        const member = await currentMember(this.context, entry.user_id);
        this.eligible(definition, entry.user_id, member.roles);
        eligible.push(entry);
      } catch (error) {
        if (!(error instanceof HttpError) && (error as { code?: number }).code !== 10007) throw error;
      }
    }
    const results: string[] = [];
    while (eligible.length && results.length < definition.winners) {
      let index = randomInt(eligible.reduce((sum, item) => sum + item.chances, 0));
      const winner = eligible.findIndex((entry) => (index -= entry.chances) < 0);
      results.push(eligible.splice(winner, 1)[0].user_id);
    }
    this.context.store.sqlite
      .transaction(() => {
        if (
          !this.context.store.sqlite
            .prepare(
              "UPDATE giveaways SET state='ended',results=?,version=version+1,delivery_state='pending',reason=? WHERE id=? AND version=? AND state='drawing'",
            )
            .run(JSON.stringify(results), reason, id, row.version).changes
        )
          throw new HttpError(409, 'Результат уже сохранён');
        this.context.store.sqlite
          .prepare(
            'INSERT INTO giveaway_history(giveaway_id,actor,result,reason,created_at) VALUES(?,?,?,?,?)',
          )
          .run(id, actor, JSON.stringify(results), reason, Date.now());
      })
      .immediate();
    return this.get(id);
  }
  cancel(id: string, reason: string) {
    if (
      !this.context.store.sqlite
        .prepare(
          "UPDATE giveaways SET state='cancelled',reason=?,version=version+1,delivery_state='pending' WHERE id=? AND state IN ('scheduled','open')",
        )
        .run(reason, id).changes
    )
      throw new HttpError(409, 'Нельзя отменить завершённый розыгрыш');
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const row of this.list().filter((row) => ['scheduled', 'open', 'drawing'].includes(row.state))) {
        const definition = giveawaySchema.parse(JSON.parse(row.document));
        if (row.state === 'drawing' || Date.now() >= definition.endsAt)
          await this.end(row.id, this.context.config.clientId, 'Срок участия завершён');
        else if (row.state === 'scheduled' && Date.now() >= definition.startsAt)
          this.context.store.sqlite
            .prepare("UPDATE giveaways SET state='open',delivery_state='pending' WHERE id=?")
            .run(row.id);
      }
      for (const row of this.list().filter((row) => row.delivery_state === 'pending')) {
        const definition = giveawaySchema.parse(JSON.parse(row.document)),
          results = JSON.parse(row.results) as string[];
        const controls =
          row.state === 'open'
            ? [
                {
                  type: 1 as const,
                  components: [
                    {
                      type: 2 as const,
                      style: 1 as const,
                      label: 'Участвовать / ежедневный шанс',
                      custom_id: 'ob:giveaway:join:' + row.id,
                    },
                    {
                      type: 2 as const,
                      style: 2 as const,
                      label: 'Выйти',
                      custom_id: 'ob:giveaway:leave:' + row.id,
                    },
                  ],
                },
              ]
            : [];
        const id = await sendBlocks(
          this.context.discord,
          this.context.store,
          definition.channelId,
          [
            {
              id: 'giveaway',
              type: 'text',
              content: `## ${definition.prize}\nСостояние: ${row.state}\nОкончание: <t:${Math.floor(definition.endsAt / 1000)}:F>\nПобедителей: ${definition.winners}${row.state === 'ended' ? '\nИтоги: ' + (results.map((user) => `<@${user}>`).join(', ') || 'Нет допустимых участников') : ''}`,
            },
            ...(definition.image
              ? [
                  {
                    id: 'image',
                    type: 'gallery' as const,
                    items: [{ url: definition.image, description: definition.prize, spoiler: false }],
                  },
                ]
              : []),
          ],
          controls,
          `giveaway:${row.id}`,
          row.message_id || undefined,
        );
        this.context.store.sqlite
          .prepare("UPDATE giveaways SET message_id=?,delivery_state='sent' WHERE id=?")
          .run(id, row.id);
        if (row.state === 'ended')
          for (const user of results) {
            try {
              if (definition.rewardRole)
                await new GuildAuthority(
                  this.context.config,
                  this.context.discord,
                  this.context.store,
                ).safeRole(
                  this.context.config.clientId,
                  user,
                  definition.rewardRole,
                  [definition.rewardRole],
                  true,
                );
              if (definition.notifyDm) {
                const dm = (await restPort(this.context.discord).post('/users/@me/channels', {
                  body: { recipient_id: user },
                  signal: AbortSignal.timeout(10000),
                })) as { id: string };
                await sendBlocks(
                  this.context.discord,
                  this.context.store,
                  dm.id,
                  [{ id: 'prize', type: 'text', content: `Вы выиграли: ${definition.prize}` }],
                  [],
                  `prize:${row.id}:${row.version}:${user}`,
                );
              }
            } catch (error) {
              this.context.errors.report(error, 'giveaway.reward');
            }
          }
      }
    } finally {
      this.busy = false;
    }
  }
}
