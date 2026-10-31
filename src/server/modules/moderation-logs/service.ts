import type { Store } from '../../store.js';
import type { Config } from '../../config.js';
import type { DiscordPort } from '../../discord.js';
import { ModuleStore } from '../../module-store.js';
import {
  initialModLogConfig,
  modLogConfigSchema,
  actionTitles,
  type ModerationCase,
} from '../../../shared/moderation.js';
import { sendBlocks } from '../../module-discord.js';
import { renderTemplate } from '../../template-context.js';
import type { Block } from '../../../shared/blocks.js';
import { domainEvent } from '../../jobs.js';
import { HttpError } from '../../errors.js';
export class ModerationLogService {
  private configs: ModuleStore;
  private busy = false;
  constructor(
    private config: Config,
    private store: Store,
    private discord: DiscordPort,
    private onError: (error: unknown, scope: string) => void = () => {},
  ) {
    this.configs = new ModuleStore(store);
  }
  settings() {
    return this.configs.get('moderation-logs', modLogConfigSchema, initialModLogConfig);
  }
  async save(document: unknown, version: number) {
    const parsed = modLogConfigSchema.parse(document);
    if (
      parsed.enabled &&
      (!parsed.channelId ||
        !(await this.discord.info()).channels.some((item) => item.id === parsed.channelId))
    )
      throw new HttpError(400, 'Выберите канал журнала наказаний');
    return this.configs.save('moderation-logs', modLogConfigSchema, parsed, version);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const settings = this.settings().document;
      if (!settings.enabled || !settings.channelId) return;
      const events = this.store.sqlite
        .prepare(
          "SELECT e.* FROM domain_events e LEFT JOIN moderation_delivery d ON d.event_id=e.id WHERE e.kind='moderation.changed' AND d.event_id IS NULL ORDER BY e.created_at LIMIT 100",
        )
        .all() as { id: string; payload: string }[];
      for (const event of events) {
        const { caseId } = JSON.parse(event.payload) as { caseId: number };
        const row = this.store.sqlite.prepare('SELECT * FROM moderation_cases WHERE id=?').get(caseId) as
          ModerationCase | undefined;
        this.store.sqlite
          .prepare('INSERT INTO moderation_delivery(event_id,case_id,channel_id,state) VALUES(?,?,?,?)')
          .run(
            event.id,
            caseId,
            settings.channelId,
            row &&
              settings.actions.includes(row.action) &&
              !['prepared', 'queued', 'running'].includes(row.state)
              ? 'pending'
              : 'ignored',
          );
      }
      const pending = this.store.sqlite
        .prepare(
          "SELECT * FROM moderation_delivery WHERE state='pending' AND next_at<=? ORDER BY rowid LIMIT 10",
        )
        .all(Date.now()) as {
        event_id: string;
        case_id: number;
        channel_id: string;
        message_id: string | null;
        attempts: number;
      }[];
      for (const delivery of pending) {
        try {
          const row = this.store.sqlite
            .prepare('SELECT * FROM moderation_cases WHERE id=?')
            .get(delivery.case_id) as ModerationCase;
          const who =
            row.actor === 'unknown'
              ? 'неизвестно'
              : row.actor === this.config.clientId
                ? 'Open Bot'
                : row.actor;
          const duration = ['ban', 'tempban', 'role-mute'].includes(row.action)
            ? row.duration
              ? `${row.duration} сек. · до ${new Date(row.expires_at!).toISOString()}`
              : 'бессрочно'
            : row.duration
              ? `${row.duration} сек.`
              : 'не применяется';
          const context = {
            case: row.id,
            action: actionTitles[row.action],
            target: row.target,
            actor: who,
            reason: row.reason,
            duration,
            time: new Date(row.created_at).toISOString(),
            result: row.state,
            source: row.source,
          };
          const blocks: Block[] = settings.templates[row.action]
            ? renderTemplate(settings.templates[row.action]!, context)
            : [
                {
                  id: 'case',
                  type: 'text',
                  content: `## ${context.action} · Дело #${row.id}\n**Кого:** <@${row.target}> · ${row.target}\n**Когда:** ${context.time}\n**Кто:** ${who}\n**Почему:** ${row.reason}\n**Насколько:** ${duration}\n**Результат:** ${row.state}${row.revoked ? ' · отменено' : ''}\n**Источник:** ${row.source}`,
                },
              ];
          const previous = this.store.sqlite
            .prepare(
              'SELECT message_id FROM moderation_delivery WHERE case_id=? AND channel_id=? AND message_id IS NOT NULL ORDER BY rowid DESC LIMIT 1',
            )
            .get(row.id, delivery.channel_id) as { message_id: string } | undefined;
          let id: string;
          try {
            id = await sendBlocks(
              this.discord,
              this.store,
              delivery.channel_id,
              blocks,
              [],
              `case:${row.id}:${delivery.channel_id}`,
              previous?.message_id,
            );
          } catch (error) {
            if ((error as { code?: number }).code !== 10008) throw error;
            id = await sendBlocks(
              this.discord,
              this.store,
              delivery.channel_id,
              blocks,
              [],
              `case:${row.id}:${delivery.event_id}`,
            );
          }
          this.store.sqlite
            .prepare("UPDATE moderation_delivery SET state='sent',message_id=?,error=NULL WHERE event_id=?")
            .run(id, delivery.event_id);
        } catch (error) {
          this.store.sqlite
            .prepare('UPDATE moderation_delivery SET attempts=attempts+1,next_at=?,error=? WHERE event_id=?')
            .run(
              Date.now() + Math.min(3600000, 5000 * 2 ** Math.min(delivery.attempts, 9)),
              error instanceof Error ? error.name : 'Error',
              delivery.event_id,
            );
          this.onError(error, 'moderation-log.delivery');
        }
      }
    } finally {
      this.busy = false;
    }
  }
  external(event: { t?: string; d?: Record<string, unknown> }) {
    const config = this.settings().document;
    if (
      !config.enabled ||
      !config.externalEvents ||
      event.t !== 'GUILD_AUDIT_LOG_ENTRY_CREATE' ||
      event.d?.guild_id !== this.config.guildId
    )
      return;
    const data = event.d;
    if (typeof data.id !== 'string' || typeof data.target_id !== 'string') return;
    // Correlate our audit reason and executor; gateway callbacks never reapply sanctions.
    if (
      data.user_id === this.config.clientId &&
      typeof data.reason === 'string' &&
      /^Open Bot #\d+:/.test(data.reason)
    )
      return;
    let action: ModerationCase['action'] | undefined;
    if (data.action_type === 20) action = 'kick';
    if (data.action_type === 22) action = 'ban';
    if (data.action_type === 23) action = 'unban';
    const timeout = Array.isArray(data.changes)
      ? (data.changes.find((change: { key?: string }) => change.key === 'communication_disabled_until') as
          { new_value?: string | null } | undefined)
      : undefined;
    if (data.action_type === 24 && timeout) action = timeout.new_value ? 'timeout' : 'untimeout';
    if (!action) return;
    const now = Date.now(),
      until = timeout?.new_value ? Date.parse(timeout.new_value) : null;
    this.store.sqlite
      .transaction(() => {
        const result = this.store.sqlite
          .prepare(
            "INSERT INTO moderation_cases(operation_id,action,target,actor,reason,duration,source,state,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,'applied',?,?,?) ON CONFLICT(operation_id) DO NOTHING",
          )
          .run(
            'audit:' + data.id,
            action,
            data.target_id,
            typeof data.user_id === 'string' ? data.user_id : 'unknown',
            typeof data.reason === 'string' ? data.reason : 'Причина не указана',
            until ? Math.max(0, Math.floor((until - now) / 1000)) : null,
            'discord-audit',
            now,
            until,
            now,
          );
        if (result.changes) {
          domainEvent(this.store, 'audit:' + data.id, 'audit:' + data.id, 'moderation.changed', {
            caseId: Number(result.lastInsertRowid),
          });
          this.store.sqlite
            .prepare('DELETE FROM moderation_active WHERE target=? AND kind=?')
            .run(data.target_id, ['timeout', 'untimeout'].includes(action!) ? 'timeout' : 'ban');
        }
      })
      .immediate();
  }
}
