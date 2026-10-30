import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { REST, Routes, MessageFlags } from 'discord.js';
import type { Config } from '../config.js';
import { secretValues } from '../module-http.js';
import { telemetry } from '../telemetry.js';

export type ErrorReport = {
  id: string;
  time: number;
  pid: number;
  process: string;
  scope: string;
  fatal: boolean;
  error: { name: string; message: string; stack?: string; cause?: unknown; code?: string };
  context: Record<string, unknown>;
};
type Pending = { report: ErrorReport; attempts: number; nextAttempt: number };

/** A disk outbox works even when SQLite or the Gateway is unavailable. Only the supervisor delivers it. */
export class ErrorReporter {
  readonly root: string;
  private rest: REST;
  private timer?: ReturnType<typeof setInterval>;
  private sending = false;
  private cursor = 0;
  private stopped = false;
  private secrets: string[];
  constructor(
    private config: Config,
    private role: string,
  ) {
    this.root = resolve(dirname(config.databasePath), 'errors');
    this.rest = new REST({ version: '10', timeout: 8000, retries: 0 }).setToken(config.token);
    this.secrets = [
      ...secretValues(config),
      config.redisUrl ? decodeURIComponent(new URL(config.redisUrl).password) : '',
    ].filter(Boolean);
  }
  redact(text: string) {
    for (const secret of this.secrets) text = text.split(secret).join('[REDACTED]');
    return text
      .replace(/rediss?:\/\/[^\s"<>]+/gi, '[REDACTED_REDIS_URL]')
      .replace(/(\/api\/(?:v\d+\/)?webhooks\/\d+\/)[\w.-]+/g, '$1[REDACTED]')
      .replace(
        /((?:authorization|cookie|client_secret|access_token|refresh_token|csrf|oauth_code)["']?\s*[:=]\s*)[^\s,;]+/gi,
        '$1[REDACTED]',
      );
  }
  private describe(error: unknown, depth = 0): ErrorReport['error'] {
    if (!(error instanceof Error))
      return { name: 'NonErrorRejection', message: this.redact(String(error)).slice(0, 8000) };
    return {
      name: error.name,
      message: this.redact(error.message).slice(0, 8000),
      stack: this.redact(error.stack || '').slice(0, 60000),
      ...('code' in error ? { code: String(error.code) } : {}),
      ...(error.cause && depth < 3 ? { cause: this.describe(error.cause, depth + 1) } : {}),
    };
  }
  report(error: unknown, scope: string, context: Record<string, unknown> = {}, fatal = false) {
    telemetry.errors.inc({ process: this.role });
    const seen = new WeakSet<object>();
    const safeContext = JSON.stringify(context, (key, value: unknown) => {
      if (/token|secret|password|cookie|authorization|csrf|webhook/i.test(key)) return '[REDACTED]';
      if (typeof value === 'string') return this.redact(value);
      if (typeof value === 'bigint') return String(value);
      if (value && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
    const report: ErrorReport = {
      id: randomUUID(),
      time: Date.now(),
      pid: process.pid,
      process: this.role,
      scope,
      fatal,
      error: this.describe(error),
      context: JSON.parse(safeContext),
    };
    const line = JSON.stringify(report);
    try {
      mkdirSync(resolve(this.root, 'pending'), { recursive: true });
      appendFileSync(
        resolve(
          this.root,
          'errors-' +
            new Date(report.time).toISOString().slice(0, 10) +
            '-' +
            this.role +
            '-' +
            process.pid +
            '.jsonl',
        ),
        line + '\n',
      );
      if (this.config.logChannelId || this.config.logWebhook) {
        const path = resolve(this.root, 'pending', report.id + '.json');
        writeFileSync(
          path + '.tmp',
          JSON.stringify({ report, attempts: 0, nextAttempt: 0 } satisfies Pending),
        );
        renameSync(path + '.tmp', path);
      }
    } catch (writeError) {
      process.stderr.write(
        JSON.stringify({ kind: 'error-log-write-failed', id: report.id, error: this.describe(writeError) }) +
          '\n',
      );
    }
    process.stderr.write(line + '\n');
    return report.id;
  }
  startDelivery(botReady: () => boolean) {
    this.timer = setInterval(() => {
      void this.flush(botReady());
    }, 5000);
    this.timer.unref();
  }
  private payload(report: ErrorReport) {
    const serialized = JSON.stringify(report, null, 2);
    const description = `## ${report.fatal ? 'Критическая ошибка' : 'Ошибка'} Open Bot\n**ID:** \`${report.id}\`\n**Модуль:** ${report.scope}\n**Процесс:** ${report.process} · PID ${report.pid}\n**Время:** <t:${Math.floor(report.time / 1000)}:F>\n**${report.error.name}**\n${report.error.message}\n\`\`\`text\n${(report.error.stack || '').replace(/```/g, '``\u200b`')}\n\`\`\`\nПолный отчёт — во вложении.`;
    let content = description.slice(0, 2800);
    while (Buffer.byteLength(JSON.stringify(content)) > 6500) content = content.slice(0, -100);
    const filename = 'error-' + report.id + '.json';
    const body = {
      flags: MessageFlags.IsComponentsV2 | MessageFlags.SuppressNotifications,
      allowed_mentions: { parse: [] },
      components: [
        {
          type: 17,
          accent_color: 0xc84b4b,
          components: [
            { type: 10, content },
            { type: 13, file: { url: 'attachment://' + filename } },
          ],
        },
      ],
      attachments: [{ id: 0, filename }],
    };
    return { body, serialized, filename };
  }
  private async deliver(report: ErrorReport, botReady: boolean) {
    const { body, serialized, filename } = this.payload(report);
    let channelError: unknown;
    if (this.config.logChannelId && botReady) {
      try {
        await this.rest.post(Routes.channelMessages(this.config.logChannelId), {
          body,
          files: [{ name: filename, data: Buffer.from(serialized) }],
          signal: AbortSignal.timeout(10000),
        });
        return;
      } catch (error) {
        channelError = error;
      }
    }
    if (this.config.logWebhook) {
      const form = new FormData();
      form.append('payload_json', JSON.stringify(body));
      form.append('files[0]', new Blob([serialized], { type: 'application/json' }), filename);
      const url = new URL(this.config.logWebhook);
      url.searchParams.set('wait', 'true');
      url.searchParams.set('with_components', 'true');
      const response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Error webhook returned HTTP ' + response.status);
      }
      await response.body?.cancel();
      return;
    }
    throw channelError || new Error('Bot error channel is currently unavailable; report remains queued');
  }
  async flush(botReady: boolean) {
    if (this.stopped || this.sending || (!this.config.logChannelId && !this.config.logWebhook)) return;
    this.sending = true;
    try {
      const pending = resolve(this.root, 'pending');
      mkdirSync(pending, { recursive: true });
      // Limit work per tick, not the persistent queue: an error burst cannot create unbounded parallel requests.
      const names = readdirSync(pending)
        .filter((name) => name.endsWith('.json'))
        .sort();
      if (this.cursor >= names.length) this.cursor = 0;
      const batch = names.slice(this.cursor, this.cursor + 100);
      this.cursor += batch.length;
      for (const name of batch) {
        if (this.stopped) break;
        const path = resolve(pending, name);
        let item: Pending;
        try {
          item = JSON.parse(readFileSync(path, 'utf8')) as Pending;
          if (
            !item.report?.id ||
            !item.report.error ||
            !Number.isFinite(item.attempts) ||
            !Number.isFinite(item.nextAttempt)
          )
            throw new Error('Invalid error outbox record');
        } catch (error) {
          renameSync(path, path + '.corrupt');
          process.stderr.write(
            JSON.stringify({ kind: 'error-outbox-corrupt', file: name, error: this.describe(error) }) + '\n',
          );
          continue;
        }
        if (item.nextAttempt > Date.now()) continue;
        try {
          await this.deliver(item.report, botReady);
          unlinkSync(path);
        } catch (error) {
          item.attempts++;
          item.nextAttempt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(item.attempts, 6));
          writeFileSync(path + '.tmp', JSON.stringify(item));
          renameSync(path + '.tmp', path);
          process.stderr.write(
            JSON.stringify({
              kind: 'error-delivery-failed',
              id: item.report.id,
              attempt: item.attempts,
              error: this.describe(error),
            }) + '\n',
          );
        }
        break;
      }
    } catch (error) {
      process.stderr.write(
        JSON.stringify({ kind: 'error-outbox-failed', error: this.describe(error) }) + '\n',
      );
    } finally {
      this.sending = false;
    }
  }
  stop() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}
