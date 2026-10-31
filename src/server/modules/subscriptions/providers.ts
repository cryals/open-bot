import { z } from 'zod';
import { limitedResponse } from '../../module-http.js';
import { HttpError } from '../../errors.js';
import { IntegrationVault } from '../../integration-vault.js';
import type { Store } from '../../store.js';
import { CommunityStore } from '../../community-store.js';
export type FeedItem = {
  id: string;
  title: string;
  text: string;
  url: string;
  image?: string;
  published: number;
  type: 'video' | 'live' | 'post';
  nsfw?: boolean;
  flair?: string;
  live?: boolean;
  game?: string;
  attachments?: string[];
};
export type Provider = 'youtube' | 'twitch' | 'kick' | 'tiktok' | 'reddit' | 'vk';
export function canonicalSource(provider: Provider, input: string) {
  let source = input.trim();
  if (source.includes('://')) {
    let url: URL;
    try {
      url = new URL(source);
    } catch {
      throw new HttpError(400, 'Некорректная ссылка источника');
    }
    const hosts: Record<Provider, string[]> = {
      youtube: ['youtube.com', 'www.youtube.com'],
      twitch: ['twitch.tv', 'www.twitch.tv'],
      kick: ['kick.com', 'www.kick.com'],
      tiktok: ['tiktok.com', 'www.tiktok.com'],
      reddit: ['reddit.com', 'www.reddit.com'],
      vk: ['vk.com', 'www.vk.com'],
    };
    if (url.protocol !== 'https:' || !hosts[provider].includes(url.hostname) || url.username || url.password)
      throw new HttpError(400, 'Источник должен принадлежать выбранной платформе');
    source = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    if (provider === 'youtube') source = source.replace(/^channel\//, '');
    if (provider === 'reddit') source = source.replace(/^r\//, '');
  }
  if (!/^[\p{L}\p{N}@_.-]{1,150}$/u.test(source))
    throw new HttpError(400, 'Укажите ID, handle или ссылку профиля / сообщества');
  return provider === 'youtube' || provider === 'tiktok' ? source : source.replace(/^@/, '').toLowerCase();
}
async function request(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok)
    throw new HttpError(
      response.status === 401 || response.status === 403 ? 403 : 502,
      `API источника: HTTP ${response.status}`,
    );
  return JSON.parse(await limitedResponse(response, 2 * 1024 * 1024)) as Record<string, unknown>;
}
const array = (value: unknown) => z.array(z.record(z.string(), z.unknown())).parse(value);
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const image = (value: unknown) => {
  const url = text(value);
  return url.startsWith('https://') ? url : undefined;
};
export class FeedProviders {
  private refreshes = new Map<string, Promise<string>>();
  constructor(
    readonly vault: IntegrationVault,
    private store: Store,
  ) {}
  async token(provider: Provider, source = 'default') {
    const record = this.vault.read(provider, source) || this.vault.read(provider, 'default');
    let credentials = record?.credentials;
    if (!credentials) throw new HttpError(403, 'Подключите аккаунт ' + provider + ' в панели');
    if (credentials.expiresAt && credentials.expiresAt < Date.now() + 60000) {
      const refreshKey = provider + ':' + record!.account,
        existing = this.refreshes.get(refreshKey);
      if (existing) return existing;
      const work = (async () => {
        if (!credentials.refreshToken)
          throw new HttpError(403, 'Срок подключения истёк; авторизуйте аккаунт снова');
        const endpoints: Partial<Record<Provider, string>> = {
          twitch: 'https://id.twitch.tv/oauth2/token',
          tiktok: 'https://open.tiktokapis.com/v2/oauth/token/',
          kick: 'https://id.kick.com/oauth/token',
          vk: 'https://id.vk.com/oauth2/auth',
          reddit: 'https://www.reddit.com/api/v1/access_token',
        };
        const endpoint = endpoints[provider];
        if (!endpoint) throw new HttpError(403, 'Требуется повторное подключение');
        const prefix = provider.toUpperCase(),
          data = await request(endpoint, {
            method: 'POST',
            ...(provider === 'reddit'
              ? {
                  headers: {
                    Authorization:
                      'Basic ' +
                      Buffer.from(
                        (process.env.REDDIT_CLIENT_ID || '') + ':' + (process.env.REDDIT_CLIENT_SECRET || ''),
                      ).toString('base64'),
                    'User-Agent': 'OpenBot/1.3.0',
                  },
                }
              : {}),
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: credentials.refreshToken,
              client_id: process.env[prefix + '_CLIENT_ID'] || '',
              client_secret: process.env[prefix + '_CLIENT_SECRET'] || '',
              ...(provider === 'tiktok' ? { client_key: process.env.TIKTOK_CLIENT_ID || '' } : {}),
            }),
          });
        credentials = {
          accessToken: z.string().parse(data.access_token),
          refreshToken:
            typeof data.refresh_token === 'string' ? data.refresh_token : credentials.refreshToken,
          expiresAt: Date.now() + z.number().parse(data.expires_in) * 1000,
          scopes: credentials.scopes,
        };
        credentials = this.vault.saveIfUnchanged(provider, record!.account, record!.fingerprint, credentials);
        return credentials.accessToken;
      })();
      this.refreshes.set(refreshKey, work);
      try {
        return await work;
      } finally {
        this.refreshes.delete(refreshKey);
      }
    }
    return credentials.accessToken;
  }
  async poll(provider: Provider, source: string, includeLive = true): Promise<FeedItem[]> {
    if (provider === 'youtube') return this.youtube(source, includeLive);
    if (provider === 'twitch') {
      const headers = {
        'Client-Id': process.env.TWITCH_CLIENT_ID || '',
        Authorization: 'Bearer ' + (await this.token(provider)),
      };
      const streams = array(
        (
          await request('https://api.twitch.tv/helix/streams?user_login=' + encodeURIComponent(source), {
            headers,
          })
        ).data,
      );
      return streams.map((stream) => ({
        id: text(stream.id),
        title: text(stream.title),
        text: text(stream.user_name),
        url: 'https://www.twitch.tv/' + source,
        image: image(text(stream.thumbnail_url).replace('{width}', '1280').replace('{height}', '720')),
        published: Date.parse(text(stream.started_at)),
        type: 'live',
        live: true,
        nsfw: !!stream.is_mature,
        game: text(stream.game_name),
      }));
    }
    if (provider === 'kick') {
      const headers = { Authorization: 'Bearer ' + (await this.token(provider)) };
      const channel = array(
        (
          await request('https://api.kick.com/public/v1/channels?slug=' + encodeURIComponent(source), {
            headers,
          })
        ).data,
      )[0];
      if (!channel) throw new HttpError(404, 'Kick: канал не найден');
      const streams = array(
        (
          await request(
            'https://api.kick.com/public/v1/livestreams?broadcaster_user_id=' +
              String(channel.broadcaster_user_id),
            { headers },
          )
        ).data,
      );
      return streams.map((stream) => ({
        id: String(stream.id || String(stream.broadcaster_user_id) + ':' + String(stream.started_at)),
        title: text(stream.stream_title),
        text: source,
        url: 'https://kick.com/' + source,
        image: image(stream.thumbnail),
        published: Date.parse(text(stream.started_at)),
        type: 'live',
        live: true,
        game: text((stream.category as { name?: string })?.name),
        nsfw: !!stream.has_mature_content,
      }));
    }
    if (provider === 'tiktok') {
      const credentials = this.vault.get(provider, source);
      if (!credentials)
        throw new HttpError(
          403,
          'TikTok: нужен авторизованный creator с video.list; произвольные usernames не поддерживаются',
        );
      const data = await request(
        'https://open.tiktokapis.com/v2/video/list/?fields=id,title,video_description,cover_image_url,share_url,create_time',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + (await this.token(provider, source)),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ max_count: 20 }),
        },
      );
      return array((data.data as { videos?: unknown })?.videos).map((video) => ({
        id: text(video.id),
        title: text(video.title),
        text: text(video.video_description),
        url: text(video.share_url),
        image: image(video.cover_image_url),
        published: Number(video.create_time) * 1000,
        type: 'video',
      }));
    }
    if (provider === 'reddit') {
      const data = await request(
        'https://oauth.reddit.com/r/' + encodeURIComponent(source) + '/new?limit=25&raw_json=1',
        {
          headers: {
            Authorization: 'Bearer ' + (await this.token(provider)),
            'User-Agent': 'OpenBot/1.3.0 (github.com/cryals/open-bot)',
          },
        },
      );
      return array((data.data as { children?: unknown })?.children).map((child) => {
        const post = child.data as Record<string, unknown>;
        return {
          id: text(post.name),
          title: text(post.title),
          text: text(post.selftext),
          url: 'https://www.reddit.com' + text(post.permalink),
          image: image(post.url),
          published: Number(post.created_utc) * 1000,
          type: 'post',
          nsfw: !!post.over_18,
          flair: text(post.link_flair_text),
          attachments: post.is_video ? ['video'] : image(post.url) ? ['image'] : [],
        };
      });
    }
    const token = await this.token('vk');
    const data = await request(
      'https://api.vk.com/method/wall.get?' +
        new URLSearchParams({ domain: source, count: '20', v: '5.199', access_token: token }),
    );
    if (data.error) throw new HttpError(403, 'VK: источник недоступен или отсутствуют scopes');
    return array((data.response as { items?: unknown })?.items).map((post) => {
      const attachments = array(post.attachments || []),
        photo = attachments.find((item) => item.type === 'photo')?.photo as
          { sizes?: { url: string; width: number }[] } | undefined;
      return {
        id: String(post.owner_id) + '_' + String(post.id),
        title: source,
        text: text(post.text),
        url: 'https://vk.com/wall' + String(post.owner_id) + '_' + String(post.id),
        image: image(photo?.sizes?.sort((a, b) => b.width - a.width)[0]?.url),
        published: Number(post.date) * 1000,
        type: 'post',
        attachments: attachments.map((item) => text(item.type)),
      };
    });
  }
  private async youtube(source: string, includeLive: boolean): Promise<FeedItem[]> {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) throw new HttpError(403, 'Для YouTube задайте технический YOUTUBE_API_KEY');
    const channelData = await request(
      'https://www.googleapis.com/youtube/v3/channels?' +
        new URLSearchParams({
          part: 'contentDetails',
          ...(source.startsWith('@') ? { forHandle: source } : { id: source }),
          key,
        }),
    );
    const channels = array(channelData.items);
    if (!channels.length) throw new HttpError(404, 'YouTube: канал не найден');
    const playlist = (channels[0].contentDetails as { relatedPlaylists: { uploads: string } })
      .relatedPlaylists.uploads;
    const states = new CommunityStore(this.store),
      settings = states.config('subscriptions').document;
    const previous = states.state<{ ids: string[]; nextAt: number }>(
      'subscriptions',
      'youtube-live:' + source,
    ) || { ids: [], nextAt: 0 };
    if (includeLive && Date.now() >= previous.nextAt) {
      const day = new Date().toISOString().slice(0, 10),
        budget = states.state<number>('subscriptions', 'youtube-budget:' + day) || 0;
      if (budget < settings.youtubeSearchDailyBudget) {
        states.set('subscriptions', 'youtube-budget:' + day, budget + 1);
        const live = await request(
          'https://www.googleapis.com/youtube/v3/search?' +
            new URLSearchParams({
              part: 'snippet',
              channelId: text(channels[0].id),
              eventType: 'live',
              type: 'video',
              maxResults: '10',
              key,
            }),
        );
        previous.ids = [
          ...new Set([
            ...previous.ids,
            ...array(live.items).map((item) => text((item.id as { videoId: string }).videoId)),
          ]),
        ].slice(-20);
      }
      previous.nextAt = Date.now() + settings.youtubeLiveSearchSeconds * 1000;
      states.set('subscriptions', 'youtube-live:' + source, previous);
    }
    const playlistData = await request(
      'https://www.googleapis.com/youtube/v3/playlistItems?' +
        new URLSearchParams({ part: 'snippet,contentDetails', playlistId: playlist, maxResults: '20', key }),
    );
    let ids = array(playlistData.items).map((item) =>
      text((item.contentDetails as { videoId: string }).videoId),
    );
    ids = [...new Set([...ids, ...previous.ids])];
    if (!ids.length) return [];
    const videos = await request(
      'https://www.googleapis.com/youtube/v3/videos?' +
        new URLSearchParams({ part: 'snippet,contentDetails,liveStreamingDetails', id: ids.join(','), key }),
    );
    const result: FeedItem[] = array(videos.items).map((video) => {
      const snippet = video.snippet as Record<string, unknown>,
        live = video.liveStreamingDetails as { actualStartTime?: string; actualEndTime?: string } | undefined;
      return {
        id: text(video.id),
        title: text(snippet.title),
        text: text(snippet.description),
        url: 'https://www.youtube.com/watch?v=' + text(video.id),
        image: image((snippet.thumbnails as { high?: { url: string } })?.high?.url),
        published: Date.parse(text(snippet.publishedAt)),
        type: live?.actualStartTime ? 'live' : 'video',
        live: !!live?.actualStartTime && !live.actualEndTime,
        nsfw:
          (video.contentDetails as { contentRating?: { ytRating?: string } })?.contentRating?.ytRating ===
          'ytAgeRestricted',
      };
    });
    states.set('subscriptions', 'youtube-live:' + source, {
      ...previous,
      ids: result.filter((item) => item.type === 'live' && item.live).map((item) => item.id),
    });
    return result;
  }
}
