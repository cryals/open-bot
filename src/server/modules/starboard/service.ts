import type { ModuleContext } from '../../runtime/types.js';
import { CommunityStore } from '../../community-store.js';
import { restPort } from '../../module-http.js';
import { sendBlocks } from '../../module-discord.js';
import type { APIChannel, APIMessage, APIUser } from 'discord.js';
import { PermissionFlagsBits as P } from 'discord.js';
import { currentMember } from '../anti-raid/service.js';
import { HttpError } from '../../errors.js';
import type { Block } from '../../../shared/blocks.js';
type Mapping = {
  board_id: string;
  source_id: string;
  source_channel: string;
  message_id: string | null;
  votes: number;
  hidden: number;
};
export class StarboardService {
  private configs: CommunityStore;
  constructor(private context: ModuleContext) {
    this.configs = new CommunityStore(context.store);
  }
  async event(data: Record<string, unknown>) {
    const config = this.configs.config('starboard').document;
    if (!config.enabled) return;
    const channel = String(data.channel_id),
      id = String(data.message_id || data.id);
    for (const board of config.boards) {
      if (!board.sourceChannels.includes(channel) || board.channelId === channel) continue;
      this.configs.set('starboard', 'pending:' + board.id + ':' + id, { board: board.id, channel, id });
    }
  }
  async tick() {
    const config = this.configs.config('starboard').document;
    if (!config.enabled) return;
    const pending = this.context.store.sqlite
      .prepare(
        "SELECT key,document FROM module_state WHERE module='starboard' AND key LIKE 'pending:%' ORDER BY updated_at LIMIT 10",
      )
      .all() as { key: string; document: string }[];
    for (const item of pending) {
      const value = JSON.parse(item.document) as { board: string; channel: string; id: string };
      const board = config.boards.find((board) => board.id === value.board);
      if (!board) {
        this.removePending(item.key);
        continue;
      }
      if (
        this.context.store.sqlite
          .prepare('SELECT 1 FROM tickets WHERE channel_id=? OR thread_id=? OR staff_channel_id=? LIMIT 1')
          .get(value.channel, value.channel, value.channel)
      ) {
        this.removePending(item.key);
        continue;
      }
      const protectedChannels = [
        this.context.store.getSettings().logChannelId,
        ...(this.configs.state<string[]>('starboard', 'excluded') || []),
      ];
      const modlog = new (await import('../../module-store.js')).ModuleStore(this.context.store).get(
        'moderation-logs',
        (await import('../../../shared/moderation.js')).modLogConfigSchema,
        (await import('../../../shared/moderation.js')).initialModLogConfig,
      ).document.channelId;
      if (
        protectedChannels.includes(value.channel) ||
        value.channel === modlog ||
        config.boards.some((other) => other.channelId === value.channel)
      ) {
        this.removePending(item.key);
        continue;
      }
      const rest = restPort(this.context.discord);
      let source: APIChannel, destination: APIChannel;
      try {
        [source, destination] = await Promise.all([
          rest.get(`/channels/${value.channel}`, {
            signal: AbortSignal.timeout(10000),
          }) as Promise<APIChannel>,
          rest.get(`/channels/${board.channelId}`, {
            signal: AbortSignal.timeout(10000),
          }) as Promise<APIChannel>,
        ]);
      } catch (error) {
        if ((error as { code?: number }).code !== 10003) throw error;
        const copy = this.context.store.sqlite
          .prepare('SELECT message_id FROM starboard_messages WHERE board_id=? AND source_id=?')
          .get(board.id, value.id) as { message_id: string | null } | undefined;
        if (copy?.message_id) await this.removeCopy(board.channelId, copy.message_id);
        this.removePending(item.key);
        continue;
      }
      if (
        !('guild_id' in source) ||
        !('guild_id' in destination) ||
        source.guild_id !== this.context.config.guildId ||
        destination.guild_id !== this.context.config.guildId
      )
        throw new HttpError(403, 'Источник или доска другого сервера');
      if (source.type === 12 || source.type === 11 || source.type === 10) {
        this.removePending(item.key);
        continue;
      }
      const privacy = (channel: APIChannel) =>
        ('permission_overwrites' in channel ? channel.permission_overwrites || [] : [])
          .filter((entry) => (BigInt(entry.allow) | BigInt(entry.deny)) & P.ViewChannel)
          .map((entry) => ({
            id: entry.id,
            type: entry.type,
            allow: String(BigInt(entry.allow) & P.ViewChannel),
            deny: String(BigInt(entry.deny) & P.ViewChannel),
          }))
          .sort((a, b) => a.id.localeCompare(b.id));
      if (
        JSON.stringify(privacy(source)) !== JSON.stringify(privacy(destination)) ||
        ('nsfw' in source && source.nsfw && (!('nsfw' in destination) || !destination.nsfw))
      ) {
        this.removePending(item.key);
        continue;
      }
      let message: APIMessage | undefined;
      try {
        message = (await rest.get(`/channels/${value.channel}/messages/${value.id}`, {
          signal: AbortSignal.timeout(10000),
        })) as APIMessage;
      } catch (error) {
        if ((error as { code?: number }).code !== 10008) throw error;
      }
      const mapping = this.context.store.sqlite
        .prepare('SELECT * FROM starboard_messages WHERE board_id=? AND source_id=?')
        .get(board.id, value.id) as Mapping | undefined;
      if (mapping?.hidden) {
        this.removePending(item.key);
        continue;
      }
      if (!message || (!board.allowBots && message.author.bot)) {
        if (mapping?.message_id) await this.removeCopy(board.channelId, mapping.message_id);
        this.removePending(item.key);
        continue;
      }
      const voters = new Set<string>();
      let after: string | undefined;
      for (;;) {
        const page = (await rest.get(
          `/channels/${value.channel}/messages/${value.id}/reactions/${encodeURIComponent(board.emoji)}`,
          {
            query: new URLSearchParams({ limit: '100', ...(after ? { after } : {}) }),
            signal: AbortSignal.timeout(10000),
          },
        )) as APIUser[];
        for (const user of page) {
          if (user.bot || (!board.allowSelf && user.id === message.author.id)) continue;
          if (board.voterRoles.length) {
            try {
              const member = await currentMember(this.context, user.id);
              if (!board.voterRoles.some((role) => member.roles.includes(role))) continue;
            } catch (error) {
              if ((error as { code?: number }).code === 10007) continue;
              throw error;
            }
          }
          voters.add(user.id);
        }
        if (page.length < 100 || voters.size >= 10000) break;
        after = page.at(-1)!.id;
      }
      if (voters.size < board.threshold) {
        if (mapping?.message_id && board.belowThreshold === 'remove') {
          await this.removeCopy(board.channelId, mapping.message_id);
          this.context.store.sqlite
            .prepare('UPDATE starboard_messages SET message_id=NULL,votes=? WHERE board_id=? AND source_id=?')
            .run(voters.size, board.id, value.id);
        }
        this.removePending(item.key);
        continue;
      }
      const blocks: Block[] = [
        {
          id: 'star',
          type: 'text',
          content: `## ${board.emoji} ${voters.size}\n**${message.author.username}**\n${message.content.slice(0, 2500)}\n[Исходное сообщение](https://discord.com/channels/${this.context.config.guildId}/${value.channel}/${value.id})`,
        },
      ];
      const images = message.attachments
        .filter((file) => file.content_type?.startsWith('image/'))
        .slice(0, 10);
      if (images.length)
        blocks.push({
          id: 'images',
          type: 'gallery',
          items: images.map((file) => ({
            url: file.url,
            description: file.filename,
            spoiler: !!file.filename.startsWith('SPOILER_'),
          })),
        });
      const id = await sendBlocks(
        this.context.discord,
        this.context.store,
        board.channelId,
        blocks,
        [],
        `star:${board.id}:${value.id}`,
        mapping?.message_id || undefined,
      );
      this.context.store.sqlite
        .prepare(
          'INSERT INTO starboard_messages(board_id,source_id,source_channel,message_id,votes) VALUES(?,?,?,?,?) ON CONFLICT(board_id,source_id) DO UPDATE SET message_id=excluded.message_id,votes=excluded.votes',
        )
        .run(board.id, value.id, value.channel, id, voters.size);
      this.removePending(item.key);
    }
  }
  private removePending(key: string) {
    this.context.store.sqlite.prepare("DELETE FROM module_state WHERE module='starboard' AND key=?").run(key);
  }
  private async removeCopy(channel: string, id: string) {
    try {
      await restPort(this.context.discord).delete(`/channels/${channel}/messages/${id}`, {
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      if (![10008, 10003].includes((error as { code?: number }).code || 0)) throw error;
    }
  }
  async hide(board: string, id: string) {
    const config = this.configs.config('starboard').document.boards.find((item) => item.id === board);
    if (!config) throw new HttpError(404, 'Доска не найдена');
    const mapping = this.context.store.sqlite
      .prepare('SELECT * FROM starboard_messages WHERE board_id=? AND source_id=?')
      .get(board, id) as Mapping | undefined;
    if (!mapping) throw new HttpError(404, 'Публикация не найдена');
    if (mapping.message_id) await this.removeCopy(config.channelId, mapping.message_id);
    this.context.store.sqlite
      .prepare('UPDATE starboard_messages SET hidden=1 WHERE board_id=? AND source_id=?')
      .run(board, id);
  }
}
