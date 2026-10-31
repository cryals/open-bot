import { FakeDiscord, testConfig } from './fixtures.js';
import type { RestPort } from '../src/server/module-http.js';
import type { Access, TicketConfig } from '../src/shared/modules.js';
import { initialTicketConfig } from '../src/shared/modules.js';
export const STAFF = '777777777777777777',
  PARENT = '888888888888888888',
  SUPPORT = '999999999999999999',
  AUTHOR = '666666666666666666',
  VIEWER = '123456789012345678',
  MANAGER = '123456789012345679';
export const ticketSettings: TicketConfig = {
  ...initialTicketConfig,
  enabled: true,
  staffChannelId: STAFF,
  categories: [
    {
      id: 'question',
      name: 'Вопрос',
      description: 'Помощь',
      emoji: '',
      channelName: 'ticket-{id}',
      enabled: true,
      parentId: PARENT,
      supportRoles: [SUPPORT],
      mentionRole: null,
      intro: [{ id: 'intro', type: 'text', content: 'Опишите проблему' }],
      questions: [],
    },
  ],
};
export class ModuleDiscord extends FakeDiscord {
  channels = new Map<string, Record<string, unknown>>([
    [PARENT, { id: PARENT, type: 4, guild_id: testConfig.guildId, name: 'Обращения' }],
    [
      STAFF,
      {
        id: STAFF,
        type: 0,
        guild_id: testConfig.guildId,
        name: 'служебный',
        permission_overwrites: [
          { id: testConfig.guildId, type: 0, allow: '0', deny: '1024' },
          ...[initialTicketConfig.fullRoleId, initialTicketConfig.viewRoleId].map((id) => ({
            id,
            type: 0,
            allow: '1024',
            deny: '0',
          })),
        ],
      },
    ],
    [
      '333333333333333333',
      { id: '333333333333333333', type: 0, guild_id: testConfig.guildId, name: 'панель' },
    ],
  ]);
  messages = new Map<string, Record<string, unknown>[]>();
  members = new Map<string, Set<string>>();
  deleted: string[] = [];
  failDelete = false;
  serial = 1566000000000000000n;
  accessMap = new Map<string, Access>([
    [AUTHOR, { admin: true, ticketManage: true, ticketView: true }],
    [VIEWER, { admin: false, ticketManage: false, ticketView: true }],
    [MANAGER, { admin: false, ticketManage: true, ticketView: true }],
  ]);
  async access(user: string) {
    return this.accessMap.get(user) || { admin: false, ticketManage: false, ticketView: false };
  }
  override async authorize(user?: string) {
    return user ? (await this.access(user)).admin : true;
  }
  readonly rest: RestPort;
  constructor() {
    super();
    this.rest = Object.fromEntries(
      ['get', 'post', 'put', 'patch', 'delete'].map((method) => [
        method,
        (path: string, options?: { body?: Record<string, unknown>; query?: URLSearchParams }) =>
          this.request(method, path, options),
      ]),
    ) as unknown as RestPort;
  }
  private async request(
    method: string,
    path: string,
    options?: { body?: Record<string, unknown>; query?: URLSearchParams },
  ): Promise<unknown> {
    const body = options?.body || {},
      parts = path.split('/').filter(Boolean);
    if (parts[0] === 'guilds') {
      if (parts.length === 2) return { id: testConfig.guildId, owner_id: AUTHOR, name: 'Demo guild' };
      if (parts[2] === 'channels') {
        if (method === 'get') return [...this.channels.values()].filter((channel) => channel.type !== 12);
        const channel = { ...body, id: String(++this.serial), guild_id: testConfig.guildId };
        this.channels.set(channel.id, channel);
        return channel;
      }
      if (parts[2] === 'threads')
        return { threads: [...this.channels.values()].filter((channel) => channel.type === 12) };
      if (parts[2] === 'roles')
        return [
          testConfig.guildId,
          SUPPORT,
          initialTicketConfig.fullRoleId,
          initialTicketConfig.viewRoleId,
          '444444444444444444',
        ].map((id, position) => ({
          id,
          name: id,
          permissions: id === '444444444444444444' ? '8' : '0',
          position,
        }));
      if (parts[2] === 'members')
        return {
          user: { id: parts[3], username: 'Demo user' },
          roles:
            parts[3] === testConfig.clientId || parts[3] === AUTHOR
              ? ['444444444444444444']
              : parts[3] === MANAGER
                ? [SUPPORT, initialTicketConfig.fullRoleId]
                : [initialTicketConfig.viewRoleId],
        };
    }
    if (parts[0] === 'channels') {
      const channelId = parts[1];
      if (parts[2] === 'threads') {
        const thread = {
          ...body,
          id: String(++this.serial),
          guild_id: testConfig.guildId,
          parent_id: channelId,
        };
        this.channels.set(thread.id, thread);
        this.members.set(thread.id, new Set([testConfig.clientId]));
        return thread;
      }
      if (parts[2] === 'thread-members') {
        const members = this.members.get(channelId) || new Set<string>();
        if (method === 'get') return [...members].map((user_id) => ({ user_id }));
        if (method === 'put') members.add(parts[3]);
        if (method === 'delete') members.delete(parts[3]);
        this.members.set(channelId, members);
        return {};
      }
      if (parts[2] === 'permissions') return {};
      if (parts[2] === 'messages') {
        const messages = this.messages.get(channelId) || [];
        if (method === 'delete') {
          this.messages.set(
            channelId,
            messages.filter((message) => message.id !== parts[3]),
          );
          return {};
        }
        if (method === 'get') {
          const before = options?.query?.get('before');
          return messages
            .filter((message) => !before || BigInt(String(message.id)) < BigInt(before))
            .sort((a, b) => (BigInt(String(a.id)) > BigInt(String(b.id)) ? -1 : 1))
            .slice(0, 100);
        }
        if (method === 'patch') {
          const message = messages.find((message) => message.id === parts[3]);
          if (!message) throw Object.assign(new Error('Missing message'), { code: 10008 });
          Object.assign(message, body);
          return message;
        }
        const existing = messages.find((message) => message.nonce === body.nonce);
        if (existing) return existing;
        const message = {
          ...body,
          id: String(++this.serial),
          channel_id: channelId,
          author: { id: testConfig.clientId, username: 'Open Bot', bot: true },
          content: '',
          attachments: [],
          timestamp: new Date().toISOString(),
        };
        messages.push(message);
        this.messages.set(channelId, messages);
        return message;
      }
      const channel = this.channels.get(channelId);
      if (!channel) throw Object.assign(new Error('Missing channel'), { code: 10003 });
      if (method === 'delete') {
        if (this.failDelete) throw new Error('Simulated delete failure');
        this.channels.delete(channelId);
        this.deleted.push(channelId);
        return {};
      }
      if (method === 'patch') {
        Object.assign(channel, body);
        return channel;
      }
      return channel;
    }
    throw new Error('Unhandled fake route ' + method + ' ' + path);
  }
}
