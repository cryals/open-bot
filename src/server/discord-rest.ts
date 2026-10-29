import {
  REST,
  Routes,
  ChannelType,
  PermissionFlagsBits,
  DiscordAPIError,
  MessageFlags,
  type APIGuild,
  type APIGuildMember,
  type APIRole,
  type APIChannel,
  type APIMessage,
} from 'discord.js';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { DiscordPort } from './discord.js';
import type { GuildInfo, RulesDocument } from '../shared/rules.js';
import type { BotMessage } from '../shared/blocks.js';
import { MediaService } from './media.js';
import { launcher } from './render.js';
import { customMessage } from './blocks.js';
import { HttpError } from './errors.js';
import { hash } from './store.js';

/** Shared REST transport: the web process does not open a second Gateway session. */
export class DiscordRest implements DiscordPort {
  readonly rest: REST;
  protected media: MediaService;
  constructor(
    protected config: Config,
    store: Store,
    private available: () => boolean = () => true,
  ) {
    this.rest = new REST({ version: '10', timeout: 10000, retries: 2 }).setToken(config.token);
    this.media = new MediaService(store);
  }
  isReady() {
    return this.available();
  }
  private signal(signal?: AbortSignal) {
    return signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  }
  async authorize(userId: string, roleId: string | null) {
    const guild = (await this.rest.get(Routes.guild(this.config.guildId), {
      signal: this.signal(),
    })) as APIGuild;
    if (userId === guild.owner_id) return true;
    let member: APIGuildMember;
    try {
      member = (await this.rest.get(Routes.guildMember(guild.id, userId), {
        signal: this.signal(),
      })) as APIGuildMember;
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === 10007) return false;
      throw error;
    }
    if (roleId) return member.roles.includes(roleId);
    const roles = (await this.rest.get(Routes.guildRoles(guild.id), { signal: this.signal() })) as APIRole[];
    return roles.some(
      (role) =>
        (role.id === guild.id || member.roles.includes(role.id)) &&
        (BigInt(role.permissions) & PermissionFlagsBits.Administrator) !== 0n,
    );
  }
  async info(): Promise<GuildInfo> {
    const [guild, channels, roles] = await Promise.all([
      this.rest.get(Routes.guild(this.config.guildId), { signal: this.signal() }) as Promise<APIGuild>,
      this.rest.get(Routes.guildChannels(this.config.guildId), { signal: this.signal() }) as Promise<
        APIChannel[]
      >,
      this.rest.get(Routes.guildRoles(this.config.guildId), { signal: this.signal() }) as Promise<APIRole[]>,
    ]);
    return {
      id: guild.id,
      name: guild.name,
      ready: this.isReady(),
      channels: channels
        .filter((channel) => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type))
        .map((channel) => ({ id: channel.id, name: channel.name || channel.id }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      roles: roles
        .filter((role) => role.id !== guild.id && !role.managed)
        .map((role) => ({ id: role.id, name: role.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }
  private async channel(id: string, signal?: AbortSignal) {
    const channel = (await this.rest.get(Routes.channel(id), { signal: this.signal(signal) })) as APIChannel;
    if (
      !('guild_id' in channel) ||
      channel.guild_id !== this.config.guildId ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
    )
      throw new HttpError(400, 'Выберите текстовый канал этого сервера');
  }
  private payload(base: unknown) {
    const { files, ...raw } = this.media.prepare(base as Record<string, unknown>);
    const { allowedMentions, ...body } = raw;
    return {
      body: {
        ...body,
        allowed_mentions: allowedMentions || { parse: [] },
        attachments: files.map((file, index) => ({ id: index, filename: file.name })),
      },
      files: files.map((file) => ({ name: file.name, data: file.attachment })),
    };
  }
  async upsert(
    document: RulesDocument,
    channelId: string,
    previous: { messageId: string | null; messageChannelId: string | null; nonce?: string },
    signal?: AbortSignal,
  ) {
    await this.channel(channelId, signal);
    const payload = this.payload(launcher(document));
    if (previous.messageId && previous.messageChannelId === channelId) {
      try {
        const message = (await this.rest.get(Routes.channelMessage(channelId, previous.messageId), {
          signal: this.signal(signal),
        })) as APIMessage;
        if (message.author.id !== this.config.clientId)
          throw new HttpError(403, 'Сохранённое сообщение принадлежит другому боту');
        await this.rest.patch(Routes.channelMessage(channelId, message.id), {
          ...payload,
          signal: this.signal(signal),
        });
        return message.id;
      } catch (error) {
        if (!(error instanceof DiscordAPIError && error.code === 10008)) throw error;
      }
    }
    return (
      (await this.rest.post(Routes.channelMessages(channelId), {
        ...payload,
        body: {
          ...payload.body,
          ...(previous.nonce ? { nonce: hash(previous.nonce).slice(0, 24), enforce_nonce: true } : {}),
        },
        signal: this.signal(signal),
      })) as APIMessage
    ).id;
  }
  async retire(channelId: string, messageId: string, signal?: AbortSignal) {
    await this.channel(channelId, signal);
    const message = (await this.rest.get(Routes.channelMessage(channelId, messageId), {
      signal: this.signal(signal),
    })) as APIMessage;
    if (message.author.id !== this.config.clientId)
      throw new HttpError(403, 'Сообщение принадлежит другому боту');
    await this.rest.delete(Routes.channelMessage(channelId, messageId), { signal: this.signal(signal) });
  }
  async sendMessage(message: BotMessage, channelId: string, requestId: string) {
    await this.channel(channelId);
    const payload = this.payload(customMessage(message));
    return (
      (await this.rest.post(Routes.channelMessages(channelId), {
        ...payload,
        body: { ...payload.body, nonce: hash(requestId).slice(0, 24), enforce_nonce: true },
        signal: this.signal(),
      })) as APIMessage
    ).id;
  }
  async editMessage(message: BotMessage, channelId: string, messageId: string) {
    await this.channel(channelId);
    const target = (await this.rest.get(Routes.channelMessage(channelId, messageId), {
      signal: this.signal(),
    })) as APIMessage;
    if (target.author.id !== this.config.clientId)
      throw new HttpError(403, 'Можно редактировать только сообщения этого бота');
    const payload = this.payload(customMessage(message));
    await this.rest.patch(Routes.channelMessage(channelId, messageId), {
      ...payload,
      body: { ...payload.body, flags: MessageFlags.IsComponentsV2 },
      signal: this.signal(),
    });
  }
}
