import { Client, Events, GatewayIntentBits, Partials } from 'discord.js';
import type { Access } from '../shared/modules.js';
import type { RestPort } from './module-http.js';
import type { GuildInfo, RulesDocument } from '../shared/rules.js';
import type { BotMessage } from '../shared/blocks.js';
import type { Store } from './store.js';
import type { Config } from './config.js';
import type { ActivityService } from './activity.js';
import { DiscordRest } from './discord-rest.js';

export interface DiscordPort {
  rest?: RestPort;
  access?(userId: string, roleId: string | null, fullRole: string, viewRole: string): Promise<Access>;
  setActivity?(activity: ActivityService): void;
  isReady(): boolean;
  authorize(userId: string, roleId: string | null): Promise<boolean>;
  info(): Promise<GuildInfo>;
  upsert(
    document: RulesDocument,
    channelId: string,
    previous: { messageId: string | null; messageChannelId: string | null; nonce?: string },
    signal?: AbortSignal,
  ): Promise<string>;
  retire(channelId: string, messageId: string, signal?: AbortSignal): Promise<void>;
  sendMessage(message: BotMessage, channelId: string, nonce: string): Promise<string>;
  editMessage(message: BotMessage, channelId: string, messageId: string): Promise<void>;
}

/** Gateway ownership only. Commands and button handlers belong to registered modules. */
export class DiscordService extends DiscordRest {
  readonly client: Client;
  private makeClient(config: Config) {
    return new Client({
      intents: [
        GatewayIntentBits.Guilds,
        ...(config.gateway?.messages ? [GatewayIntentBits.GuildMessages] : []),
        ...(config.gateway?.messageContent ? [GatewayIntentBits.MessageContent] : []),
        ...(config.gateway?.members ? [GatewayIntentBits.GuildMembers] : []),
        ...(config.gateway?.moderation ? [GatewayIntentBits.GuildModeration] : []),
        ...(config.gateway?.reactions ? [GatewayIntentBits.GuildMessageReactions] : []),
        ...(config.gateway?.autoModeration
          ? [GatewayIntentBits.AutoModerationConfiguration, GatewayIntentBits.AutoModerationExecution]
          : []),
      ],
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User, Partials.GuildMember],
      allowedMentions: { parse: [] },
      rest: { timeout: 10000, retries: 0 },
    });
  }
  private activity?: ActivityService;
  setActivity(activity: ActivityService) {
    this.activity = activity;
  }
  constructor(config: Config, store: Store, onError: (error: unknown, scope?: string) => void) {
    super(config, store);
    this.client = this.makeClient(config);
    this.client.on(Events.Error, (error) => onError(error, 'gateway'));
    this.client.on(Events.ShardError, (error, shard) => onError(error, 'gateway.shard.' + shard));
    const lifecycle = (kind: string, summary: string, details: Record<string, unknown> = {}) =>
      this.activity?.record(
        { userId: config.clientId, name: 'Open Bot' },
        { kind, target: 'discord', summary, details },
      );
    this.client.on(Events.ClientReady, () => lifecycle('bot.ready', 'Бот подключён к Discord'));
    this.client.on(Events.ShardDisconnect, (event, shardId) =>
      lifecycle('bot.disconnected', 'Соединение бота с Discord прервано', { shardId, code: event.code }),
    );
    this.client.on(Events.ShardReconnecting, (shardId) =>
      lifecycle('bot.reconnecting', 'Бот переподключается к Discord', { shardId }),
    );
    this.client.on(Events.ShardResume, (shardId) =>
      lifecycle('bot.resumed', 'Соединение бота с Discord восстановлено', { shardId }),
    );
  }
  async start() {
    await this.client.login(this.config.token);
    if (!this.client.isReady())
      await new Promise<void>((resolve) => this.client.once(Events.ClientReady, () => resolve()));
  }
  override isReady() {
    return this.client.isReady();
  }
  async stop() {
    await this.client.destroy();
  }
}
