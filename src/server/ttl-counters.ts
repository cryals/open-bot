import { createClient } from 'redis';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
/** Redis is optional. Local fallback is bounded and never contains message content. */
export class TtlCounters {
  private client?: ReturnType<typeof counterClient>;
  private local = new Map<string, { value: number; until: number }>();
  constructor(
    private config: Config,
    private onError: (error: unknown, scope: string) => void,
  ) {}
  async start() {
    if (!this.config.redisUrl) return;
    const client = counterClient(this.config.redisUrl);
    client.on('error', (error) => this.onError(error, 'counters.redis'));
    this.client = client;
    try {
      await client.connect();
    } catch (error) {
      this.onError(error, 'counters.connect');
    }
  }
  key(value: string) {
    return (this.config.redisKey || 'open-bot') + ':ttl:' + createHash('sha256').update(value).digest('hex');
  }
  async count(key: string, ttl: number, delta = 1) {
    const id = this.key(key);
    if (this.client?.isReady)
      try {
        return Number(
          await this.client.eval(
            "local n=redis.call('INCRBY',KEYS[1],ARGV[2]); if redis.call('PTTL',KEYS[1])<0 then redis.call('PEXPIRE',KEYS[1],ARGV[1]) end; return n",
            { keys: [id], arguments: [String(ttl), String(delta)] },
          ),
        );
      } catch (error) {
        this.onError(error, 'counters.increment');
      }
    const now = Date.now();
    for (const [key, item] of this.local) if (item.until <= now) this.local.delete(key);
    const previous = this.local.get(id);
    const next = {
      value: previous && previous.until > now ? previous.value + delta : delta,
      until: previous && previous.until > now ? previous.until : now + ttl,
    };
    if (this.local.size >= 10000 && !this.local.has(id)) this.local.delete(this.local.keys().next().value!);
    this.local.set(id, next);
    return next.value;
  }
  async once(key: string, ttl: number) {
    return (await this.count(key, ttl)) === 1;
  }
  async stop() {
    if (this.client?.isOpen) await this.client.close();
    this.local.clear();
  }
}
const counterClient = (url: string) =>
  createClient({ url, socket: { connectTimeout: 2000, reconnectStrategy: false } });
