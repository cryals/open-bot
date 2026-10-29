import {
  ChannelType,
  Client,
  DiscordAPIError,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  type Guild,
  type GuildTextBasedChannel,
} from 'discord.js';
import type { GuildInfo, RulesDocument } from '../shared/rules.js';
import type { Store } from './store.js';
import type { Config } from './config.js';
import { HttpError } from './errors.js';
import { launcher, menu, notice, rulesView } from './render.js';
import { MediaService } from './media.js';
import { customMessage } from './blocks.js';
import type { BotMessage } from '../shared/blocks.js';
import { hash } from './store.js';
import type { ActivityService } from './activity.js';

export interface DiscordPort {
  setActivity?(activity: ActivityService): void;
  isReady(): boolean;
  authorize(userId: string, roleId: string | null): Promise<boolean>;
  info(): Promise<GuildInfo>;
  upsert(
    document: RulesDocument,
    channelId: string,
    previous: { messageId: string | null; messageChannelId: string | null },
  ): Promise<string>;
  retire(channelId: string, messageId: string): Promise<void>;
  sendMessage(message: BotMessage, channelId: string, nonce: string): Promise<string>;
  editMessage(message: BotMessage, channelId: string, messageId: string): Promise<void>;
}

export class DiscordService implements DiscordPort {
  private activity?: ActivityService;
  setActivity(activity: ActivityService) {
    this.activity = activity;
  }
  private media: MediaService;
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  constructor(
    private config: Config,
    private store: Store,
    log: (error: unknown) => void,
  ) {
    this.media = new MediaService(store);
    this.client.on(Events.Error, (error) => log(error));
    const lifecycle = (kind: string, summary: string, details: Record<string, unknown> = {}) =>
      this.activity?.record(
        { userId: config.clientId, name: 'Open Space' },
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
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton() || !interaction.customId.startsWith('os:')) return;
      if (interaction.guildId === this.config.guildId)
        this.activity?.record(
          { userId: interaction.user.id, name: interaction.user.username },
          {
            kind: 'bot.button',
            target: interaction.customId,
            summary:
              'Нажата кнопка бота: ' +
              (('label' in interaction.component && interaction.component.label) || interaction.customId),
            details: {
              channelId: interaction.channelId,
              messageId: interaction.message.id,
              interactionId: interaction.id,
            },
          },
        );
      try {
        if (interaction.guildId !== this.config.guildId) {
          await interaction.reply({
            ...notice('Эта панель правил принадлежит другому серверу.'),
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
          return;
        }
        const parts = interaction.customId.split(':');
        const action = parts[2];
        if (parts[1] !== 'v1' || !['open', 'menu', 'page'].includes(action)) {
          await interaction.reply({
            ...notice('Кнопка устарела. Откройте правила заново.'),
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
          return;
        }
        if (action !== 'open' && parts[3] !== interaction.user.id) {
          await interaction.reply({
            ...notice('Откройте собственную панель через «Читать правила».'),
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
          return;
        }
        const document = this.store.active();
        if (!document) {
          await interaction.reply({
            ...notice('Правила ещё не опубликованы. Обратитесь к администрации.'),
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
          return;
        }
        const key = parts[4];
        const page = Number(parts[5]);
        const base =
          action === 'page' &&
          (key === 'game' || key === 'discord') &&
          Number.isSafeInteger(page) &&
          page >= 0
            ? rulesView(document, key, page, interaction.user.id)
            : menu(document, interaction.user.id);
        const response = this.media.prepare(base);
        if (action === 'open') {
          await interaction.reply({
            ...response,
            flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
          });
        } else {
          await interaction.deferUpdate();
          await interaction.editReply({ ...response, attachments: [] });
        }
      } catch (error) {
        this.activity?.record(
          { userId: interaction.user.id, name: interaction.user.username },
          {
            kind: 'bot.error',
            target: interaction.customId,
            summary: 'Ошибка обработки кнопки бота',
            details: { error: error instanceof Error ? error.name : 'Error' },
          },
        );
        log(error);
        const response = notice('Не удалось открыть правила. Попробуйте ещё раз через «Читать правила».');
        try {
          if (interaction.deferred || interaction.replied) await interaction.editReply(response);
          else
            await interaction.reply({
              ...response,
              flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
            });
        } catch (replyError) {
          log(replyError);
        }
      }
    });
  }
  async start() {
    await this.client.login(this.config.token);
    if (!this.client.isReady())
      await new Promise<void>((resolve) => this.client.once(Events.ClientReady, () => resolve()));
    await this.guild();
  }
  isReady() {
    return this.client.isReady();
  }
  async stop() {
    await this.client.destroy();
  }
  private async guild(): Promise<Guild> {
    if (!this.isReady()) throw new HttpError(503, 'Бот пока не подключён к Discord');
    return this.client.guilds.fetch(this.config.guildId);
  }
  async authorize(userId: string, roleId: string | null) {
    const guild = await this.guild();
    if (userId === guild.ownerId) return true;
    try {
      // A single member REST fetch does not require the privileged GuildMembers intent.
      const member = await guild.members.fetch({ user: userId, force: true });
      return roleId
        ? member.roles.cache.has(roleId)
        : member.permissions.has(PermissionFlagsBits.Administrator);
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === 10007) return false;
      throw error;
    }
  }
  async info(): Promise<GuildInfo> {
    const guild = await this.guild();
    const [channels, roles] = await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);
    return {
      id: guild.id,
      name: guild.name,
      ready: this.isReady(),
      channels: [...channels.values()]
        .filter(
          (channel) =>
            channel && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type),
        )
        .map((channel) => ({ id: channel!.id, name: channel!.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      roles: [...roles.values()]
        .filter((role) => role.id !== guild.id && !role.managed)
        .map((role) => ({ id: role.id, name: role.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  private async channel(id: string): Promise<GuildTextBasedChannel> {
    const guild = await this.guild();
    const channel = await guild.channels.fetch(id);
    if (
      !channel ||
      (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)
    ) {
      throw new HttpError(400, 'Выберите текстовый канал этого сервера');
    }
    const me = await guild.members.fetchMe();
    if (
      !channel
        .permissionsFor(me)
        .has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ])
    ) {
      throw new HttpError(400, 'Боту нужны права просмотра канала, отправки сообщений и чтения истории');
    }
    return channel;
  }
  async upsert(
    document: RulesDocument,
    channelId: string,
    previous: { messageId: string | null; messageChannelId: string | null },
  ) {
    const channel = await this.channel(channelId);
    const payload = this.media.prepare(launcher(document));
    if (previous.messageId && previous.messageChannelId === channelId) {
      try {
        const message = await channel.messages.fetch(previous.messageId);
        if (message.author.id !== this.client.user!.id)
          throw new HttpError(400, 'Сохранённое сообщение принадлежит другому боту');
        await message.edit({ ...payload, attachments: [] });
        return message.id;
      } catch (error) {
        if (!(error instanceof DiscordAPIError && error.code === 10008)) throw error;
      }
    }
    return (await channel.send(payload)).id;
  }
  async retire(channelId: string, messageId: string) {
    const channel = await this.channel(channelId);
    const message = await channel.messages.fetch(messageId);
    if (message.author.id === this.client.user!.id) await message.delete();
  }
  async sendMessage(message: BotMessage, channelId: string, requestId: string) {
    const channel = await this.channel(channelId);
    const payload = this.media.prepare(customMessage(message));
    return (await channel.send({ ...payload, nonce: hash(requestId).slice(0, 24), enforceNonce: true })).id;
  }
  async editMessage(message: BotMessage, channelId: string, messageId: string) {
    const channel = await this.channel(channelId);
    const target = await channel.messages.fetch(messageId);
    if (target.author.id !== this.client.user!.id)
      throw new HttpError(403, 'Можно редактировать только сообщения этого бота');
    // Notification suppression is a send-time choice; keep existing flags on edits.
    const payload = this.media.prepare(customMessage(message));
    await target.edit({ ...payload, flags: MessageFlags.IsComponentsV2, attachments: [] });
  }
}
