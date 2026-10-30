import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';
import type { DiscordPort } from './discord.js';
import type { ActivityService } from './activity.js';
import type { ErrorReporter } from './runtime/error-reporter.js';
import { MediaService } from './media.js';
import { validatePayloads, launcher, rulesView } from './render.js';
import { infoBlocks, pageBlocks, paginate, type RulesDocument } from '../shared/rules.js';
import { HttpError } from './errors.js';
import { hash } from './store.js';

export class Publisher {
  constructor(
    private store: Store,
    private discord: DiscordPort,
    private activity: ActivityService,
    private errors?: ErrorReporter,
  ) {}
  assertIdle() {
    this.store.assertEditable();
  }
  validate(document: RulesDocument) {
    const media = new MediaService(this.store);
    validatePayloads(document);
    media.validate(infoBlocks(document));
    media.prepare(launcher(document));
    for (const set of document.rulesets) {
      for (const page of set.pages) media.validate(pageBlocks(page));
      const pages = paginate(set);
      for (let index = 0; index < pages.length; index++)
        media.prepare(rulesView(document, set.key, index, '111111111111111111', pages));
    }
  }
  async publish(
    actor: { userId: string; name: string },
    options: { version: number } | { channelId?: string; signal?: AbortSignal },
  ) {
    const owner = randomUUID();
    this.store.sqlite
      .transaction(() => {
        this.assertIdle();
        this.store.sqlite
          .prepare(
            'INSERT INTO runtime_locks(name,owner,expires_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at',
          )
          .run('publication', owner, Date.now() + 90000);
      })
      .immediate();
    try {
      const settings = this.store.getSettings();
      const draft = this.store.getDraft();
      const fromDraft = 'version' in options;
      if (fromDraft && draft.version !== options.version)
        throw new HttpError(409, 'Черновик изменился. Обновите страницу перед публикацией.');
      const previous = this.store.active();
      const document = fromDraft ? draft.document : previous;
      if (!document)
        throw new HttpError(
          400,
          'Сначала опубликуйте информацию и правила через веб-панель. Команда не публикует несохранённые изменения.',
        );
      const channelId = (!fromDraft && options.channelId) || settings.channelId;
      if (!channelId) throw new HttpError(400, 'Выберите канал в настройках или укажите канал в /send-info.');
      this.validate(document);
      const fingerprint = hash(channelId + JSON.stringify(document));
      this.store.sqlite
        .prepare('INSERT OR IGNORE INTO publication_attempts(fingerprint,nonce) VALUES(?,?)')
        .run(fingerprint, randomUUID());
      const attempt = this.store.sqlite
        .prepare('SELECT nonce FROM publication_attempts WHERE fingerprint=?')
        .get(fingerprint) as { nonce: string };
      const deadline = AbortSignal.timeout(30000);
      const signal = !fromDraft && options.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
      const messageId = await this.discord.upsert(
        document,
        channelId,
        { ...settings, nonce: attempt.nonce },
        signal,
      );
      this.store.sqlite
        .transaction(() => {
          if (fromDraft) this.store.commitPublication(document, actor.userId, channelId, messageId);
          else this.store.updateLauncher(channelId, messageId, actor.userId);
          this.store.sqlite.prepare('DELETE FROM publication_attempts WHERE fingerprint=?').run(fingerprint);
        })
        .immediate();
      this.activity.record(actor, {
        kind: fromDraft ? 'rules.publish' : 'info.send',
        target: `channel:${channelId}/message:${messageId}`,
        summary: fromDraft ? 'Опубликованы информация и правила' : 'Отправлена опубликованная информация',
        details: { channelId, messageId, version: fromDraft ? draft.version : settings.publishedRevision },
        before: previous,
        after: document,
      });
      if (settings.messageId && settings.messageChannelId && settings.messageChannelId !== channelId) {
        try {
          await this.discord.retire(settings.messageChannelId, settings.messageId, signal);
          this.activity.record(actor, {
            kind: 'message.delete',
            target: settings.messageId,
            summary: 'Удалено прежнее информационное сообщение после переноса',
          });
        } catch (error) {
          this.errors?.report(error, 'info.retire', {
            channelId: settings.messageChannelId,
            messageId: settings.messageId,
          });
        }
      }
      return { channelId, messageId };
    } catch (error) {
      this.activity.record(actor, {
        kind: 'rules.publish_failed',
        target: 'publication',
        summary: 'Публикация не завершена',
        details: { error: error instanceof Error ? error.name : 'Error' },
      });
      throw error;
    } finally {
      this.store.sqlite
        .prepare('DELETE FROM runtime_locks WHERE name=? AND owner=?')
        .run('publication', owner);
    }
  }
}
