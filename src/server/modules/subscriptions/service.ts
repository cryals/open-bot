import { CommunityStore } from '../../community-store.js';
import { IntegrationVault } from '../../integration-vault.js';
import { FeedProviders, canonicalSource, type FeedItem, type Provider } from './providers.js';
import type { ModuleContext } from '../../runtime/types.js';
import { sendBlocks } from '../../module-discord.js';
import { renderTemplate } from '../../template-context.js';
import type { Block } from '../../../shared/blocks.js';
import { restPort } from '../../module-http.js';
import { telemetry } from '../../telemetry.js';
import { TwitchEvents } from './twitch-events.js';
type Delivery = {
  feed_id: string;
  content_id: string;
  document: string;
  channel_id: string;
  message_id: string | null;
  state: string;
  attempts: number;
};
export class FeedService {
  private configs: CommunityStore;
  readonly providers: FeedProviders;
  private busy = false;
  readonly twitch: TwitchEvents;
  constructor(private context: ModuleContext) {
    this.configs = new CommunityStore(context.store);
    this.providers = new FeedProviders(new IntegrationVault(context.store), context.store);
    this.twitch = new TwitchEvents(
      this.providers,
      async (source, offline) => {
        await this.offline(source, offline);
        this.context.store.sqlite
          .prepare("UPDATE feed_sources SET next_at=0 WHERE provider='twitch' AND source=?")
          .run(source);
      },
      (error) => context.errors.report(error, 'twitch.eventsub'),
    );
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const config = this.configs.config('subscriptions').document;
      if (!config.enabled) {
        this.twitch.stop();
        return;
      }
      const feeds = config.feeds.filter((feed) => feed.enabled);
      this.twitch.sources(feeds.filter((feed) => feed.provider === 'twitch').map((feed) => feed.source));
      for (const feed of feeds) {
        this.context.store.sqlite
          .prepare('INSERT INTO feed_sources(provider,source) VALUES(?,?) ON CONFLICT DO NOTHING')
          .run(feed.provider, feed.source);
        if (!this.configs.state('subscriptions', 'feed:' + feed.id))
          this.configs.set('subscriptions', 'feed:' + feed.id, { connected: Date.now(), initialized: false });
      }
      const sources = (
        this.context.store.sqlite
          .prepare('SELECT * FROM feed_sources WHERE next_at<=? ORDER BY next_at')
          .all(Date.now()) as {
          provider: Provider;
          source: string;
          cursor: string | null;
          failures: number;
          state: string;
        }[]
      )
        .filter((source) =>
          feeds.some((feed) => feed.provider === source.provider && feed.source === source.source),
        )
        .slice(0, 5);
      for (const source of sources) {
        const subscribers = feeds.filter(
          (feed) => feed.provider === source.provider && feed.source === source.source,
        );
        if (!subscribers.length) continue;
        const started = Date.now();
        try {
          const items = await this.providers.poll(
            source.provider,
            source.source,
            subscribers.some((feed) => feed.types.includes('live')),
          );
          if (['twitch', 'kick'].includes(source.provider) && !items.some((item) => item.live))
            await this.offline(source.source, true, source.provider);
          for (const feed of subscribers) {
            const state = this.configs.state<{ connected: number; initialized: boolean }>(
              'subscriptions',
              'feed:' + feed.id,
            )!;
            const seen = new Set((state as typeof state & { seen?: string[] }).seen || []);
            const selected = !state.initialized
              ? feed.backfill
                ? items.slice(0, feed.backfill)
                : items.filter((item) => item.published >= state.connected)
              : items.filter((item) => !seen.has(item.id) || item.type === 'live');
            for (const item of selected) {
              if (
                !feed.types.includes(item.type) ||
                (!feed.allowNsfw && item.nsfw) ||
                (feed.keywords.length &&
                  !feed.keywords.some((keyword) =>
                    (item.title + ' ' + item.text).toLocaleLowerCase().includes(keyword.toLocaleLowerCase()),
                  )) ||
                (feed.flairs.length && !feed.flairs.includes(item.flair || '')) ||
                (feed.attachmentTypes.length &&
                  !feed.attachmentTypes.some((type) => item.attachments?.includes(type)))
              )
                continue;
              if (item.nsfw) {
                const channel = (await restPort(this.context.discord).get(`/channels/${feed.channelId}`, {
                  signal: AbortSignal.timeout(10000),
                })) as { nsfw?: boolean };
                if (!channel.nsfw) continue;
              }
              const contentId = source.provider + ':' + item.id,
                existing = this.context.store.sqlite
                  .prepare('SELECT document FROM feed_delivery WHERE channel_id=? AND content_id=?')
                  .get(feed.channelId, contentId) as { document: string } | undefined;
              if (existing) {
                if (item.type === 'live' && JSON.parse(existing.document).live !== item.live)
                  this.context.store.sqlite
                    .prepare(
                      "UPDATE feed_delivery SET document=?,state=CASE WHEN message_id IS NOT NULL THEN 'pending' ELSE state END WHERE channel_id=? AND content_id=?",
                    )
                    .run(JSON.stringify(item), feed.channelId, contentId);
                continue;
              }
              this.context.store.sqlite
                .prepare(
                  'INSERT INTO feed_delivery(feed_id,content_id,document,channel_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
                )
                .run(feed.id, contentId, JSON.stringify(item), feed.channelId);
            }
            this.configs.set('subscriptions', 'feed:' + feed.id, {
              ...state,
              initialized: true,
              seen: [...new Set([...seen, ...items.map((item) => item.id)])].slice(-500),
            });
          }
          for (const item of items)
            this.context.store.sqlite
              .prepare(
                'INSERT INTO feed_items(provider,source,content_id,document,created_at) VALUES(?,?,?,?,?) ON CONFLICT(provider,source,content_id) DO UPDATE SET document=excluded.document',
              )
              .run(
                source.provider,
                source.source,
                item.id,
                JSON.stringify(item),
                item.published || Date.now(),
              );
          this.context.store.sqlite
            .prepare(
              "UPDATE feed_sources SET state='ready',failures=0,error=NULL,next_at=?,cursor=? WHERE provider=? AND source=?",
            )
            .run(
              Date.now() + (['twitch', 'kick'].includes(source.provider) ? 60000 : 300000),
              items[0]?.id || source.cursor,
              source.provider,
              source.source,
            );
          telemetry.observe('subscriptions', 'poll', 'success', started);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Ошибка источника';
          this.context.store.sqlite
            .prepare(
              "UPDATE feed_sources SET state='error',failures=failures+1,error=?,next_at=? WHERE provider=? AND source=?",
            )
            .run(
              message,
              Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(source.failures, 6)),
              source.provider,
              source.source,
            );
          this.context.errors.report(error, 'feed.poll', { provider: source.provider });
          telemetry.observe('subscriptions', 'poll', 'error', started);
        }
      }
      this.context.store.sqlite
        .prepare(
          "UPDATE feed_delivery SET state='unknown',error='Процесс остановился во время отправки. Нужна сверка сообщения.' WHERE state='sending'",
        )
        .run();
      const deliveries = (
        this.context.store.sqlite
          .prepare("SELECT * FROM feed_delivery WHERE state='pending' AND next_at<=? ORDER BY rowid")
          .all(Date.now()) as Delivery[]
      )
        .filter((item) => feeds.some((feed) => feed.id === item.feed_id))
        .slice(0, 10);
      for (const delivery of deliveries) {
        const feed = feeds.find((feed) => feed.id === delivery.feed_id);
        if (!feed) continue;
        const item = JSON.parse(delivery.document) as FeedItem;
        const text = feed.stripHashtags ? item.text.replace(/#[\p{L}\p{N}_]+/gu, '').trim() : item.text;
        const blocks: Block[] = feed.blocks
          ? renderTemplate(feed.blocks, {
              title: item.title,
              text: text.slice(0, 2000),
              url: item.url,
              image: item.image || '',
              source: feed.source,
              game: item.game || '',
              status: item.type === 'live' ? (item.live ? 'в эфире' : 'эфир завершён') : '',
            })
          : [
              {
                id: 'feed',
                type: 'text',
                content: `## ${item.title.slice(0, 200)}${item.type === 'live' ? ' · ' + (item.live ? 'в эфире' : 'эфир завершён') : ''}\n${text.slice(0, 1800)}\n${item.url}`,
              },
              ...(item.image
                ? [
                    {
                      id: 'preview',
                      type: 'gallery' as const,
                      items: [
                        { url: item.image, description: item.title.slice(0, 300), spoiler: !!item.nsfw },
                      ],
                    },
                  ]
                : []),
            ];
        this.context.store.sqlite
          .prepare("UPDATE feed_delivery SET state='sending' WHERE feed_id=? AND content_id=?")
          .run(delivery.feed_id, delivery.content_id);
        try {
          const id = await sendBlocks(
            this.context.discord,
            this.context.store,
            delivery.channel_id,
            blocks,
            [],
            `feed:${delivery.channel_id}:${delivery.content_id}`,
            delivery.message_id || undefined,
            undefined,
            feed.delivery,
          );
          this.context.store.sqlite
            .prepare(
              "UPDATE feed_delivery SET state='sent',message_id=?,error=NULL WHERE feed_id=? AND content_id=?",
            )
            .run(id, delivery.feed_id, delivery.content_id);
        } catch (error) {
          const status = (error as { status?: number }).status,
            unknown = !delivery.message_id && !(status && status >= 400 && status < 500);
          this.context.store.sqlite
            .prepare(
              'UPDATE feed_delivery SET state=?,attempts=attempts+1,next_at=?,error=? WHERE feed_id=? AND content_id=?',
            )
            .run(
              unknown ? 'unknown' : 'pending',
              Date.now() + Math.min(3600000, 30000 * 2 ** Math.min(delivery.attempts, 6)),
              error instanceof Error ? error.name : 'Error',
              delivery.feed_id,
              delivery.content_id,
            );
          this.context.errors.report(error, 'feed.delivery');
        }
      }
    } finally {
      this.busy = false;
    }
  }
  private async offline(source: string, offline: boolean, provider: Provider = 'twitch') {
    if (!offline) return;
    const items = this.context.store.sqlite
      .prepare(
        'SELECT document FROM feed_items WHERE provider=? AND source=? ORDER BY created_at DESC LIMIT 5',
      )
      .all(provider, source) as { document: string }[];
    for (const saved of items) {
      const item = JSON.parse(saved.document) as FeedItem;
      if (item.type !== 'live' || !item.live) continue;
      item.live = false;
      this.context.store.sqlite
        .prepare('UPDATE feed_items SET document=? WHERE provider=? AND source=? AND content_id=?')
        .run(JSON.stringify(item), provider, source, item.id);
      this.context.store.sqlite
        .prepare(
          "UPDATE feed_delivery SET document=?,state=CASE WHEN message_id IS NOT NULL THEN 'pending' ELSE state END WHERE content_id=?",
        )
        .run(JSON.stringify(item), provider + ':' + item.id);
    }
  }
  stop() {
    this.twitch.stop();
  }
}
export { canonicalSource };
