import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.js';
import type { Store } from '../../store.js';
import type { ActivityService } from '../../activity.js';
import type { ErrorReporter } from '../../runtime/error-reporter.js';
import type { RuntimeStatus, ModuleLifecycle } from '../../runtime/types.js';
import { DiscordRest } from '../../discord-rest.js';
import { DiscordOAuth } from '../../oauth.js';
import { createApp } from '../../app.js';
import { webModuleMetadata } from './metadata.js';

/** Loaded only in the supervised Web process; it owns no Gateway event handlers. */
export class WebModule implements ModuleLifecycle<void> {
  readonly id = webModuleMetadata.id;
  readonly title = webModuleMetadata.title;
  readonly description = webModuleMetadata.description;
  private app?: FastifyInstance;
  constructor(
    private config: Config,
    private store: Store,
    private activity: ActivityService,
    private discord: DiscordRest,
    private errors: ErrorReporter,
    private status: () => RuntimeStatus,
  ) {}
  async start() {
    this.app = await createApp({
      config: this.config,
      store: this.store,
      discord: this.discord,
      oauth: new DiscordOAuth(this.config),
      activity: this.activity,
      errors: this.errors,
      runtime: this.status,
      activityDeliveryError: () => this.status().bot.activityError || null,
    });
    await this.app.listen({ port: this.config.port, host: this.config.host });
  }
  async stop() {
    await this.app?.close();
  }
}
