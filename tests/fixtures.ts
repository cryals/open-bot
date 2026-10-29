import type { Config } from '../src/server/config.js';
import type { DiscordPort } from '../src/server/discord.js';
import type { GuildInfo, RulesDocument } from '../src/shared/rules.js';
import type { BotMessage } from '../src/shared/blocks.js';

export const testConfig: Config = {
  token: 'test-token-never-used',
  guildId: '111111111111111111',
  clientId: '222222222222222222',
  clientSecret: 'test-client-secret',
  port: 3311,
  host: '127.0.0.1',
  redirect: new URL('http://localhost:3311/auth/discord/callback'),
  origin: 'http://localhost:3311',
  appOrigin: 'http://localhost:3311',
  secureCookies: false,
  databasePath: ':memory:',
  adminRoleId: null,
  trustProxy: false,
};
export class FakeDiscord implements DiscordPort {
  allowed = true;
  failPublish = false;
  calls = 0;
  pending: Promise<void> | null = null;
  onUpsert: () => void = () => {};
  isReady() {
    return true;
  }
  async authorize() {
    return this.allowed;
  }
  async info(): Promise<GuildInfo> {
    return {
      id: testConfig.guildId,
      name: 'Open Space',
      ready: true,
      channels: [{ id: '333333333333333333', name: 'правила' }],
      roles: [{ id: '444444444444444444', name: 'Администратор' }],
    };
  }
  async upsert(_document: RulesDocument, _channelId: string) {
    this.calls++;
    this.onUpsert();
    if (this.pending) await this.pending;
    if (this.failPublish) throw new Error('Simulated Discord outage');
    return '555555555555555555';
  }
  async retire() {}
  sent: BotMessage[] = [];
  failAt = -1;
  async sendMessage(message: BotMessage) {
    if (this.sent.length === this.failAt) throw new Error('Simulated send failure');
    this.sent.push(message);
    return String(777777777777777770n + BigInt(this.sent.length));
  }
  async editMessage(message: BotMessage) {
    this.sent[0] = message;
  }
}
