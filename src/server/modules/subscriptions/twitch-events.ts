import type { FeedProviders } from './providers.js';
import { limitedResponse } from '../../module-http.js';
/** One EventSub socket, persistent feed cursors are the deduplication authority. */
export class TwitchEvents {
  private socket?: WebSocket;
  private names: string[] = [];
  private current = '';
  private next = 0;
  private failures = 0;
  private lastBeat = 0;
  private deadline = 45000;
  private stopped = false;
  constructor(
    private providers: FeedProviders,
    private notify: (source: string, offline: boolean) => Promise<void>,
    private onError: (error: unknown) => void,
  ) {}
  sources(names: string[]) {
    if (!this.providers.vault.get('twitch', 'default')) {
      this.stop();
      return;
    }
    this.names = [...new Set(names)].sort();
    const key = this.names.join(',');
    if (!key) {
      this.stop();
      return;
    }
    this.stopped = false;
    if (this.socket && this.current !== key) {
      this.socket.close();
      this.socket = undefined;
    }
    if (this.socket && Date.now() - this.lastBeat > this.deadline) {
      this.socket.close();
      this.socket = undefined;
    }
    if (!this.socket && Date.now() >= this.next && this.providers.vault.get('twitch', 'default')) {
      this.current = key;
      this.connect('wss://eventsub.wss.twitch.tv/ws');
    }
  }
  private connect(address: string, migrate = false) {
    const url = new URL(address);
    if (url.protocol !== 'wss:' || url.hostname !== 'eventsub.wss.twitch.tv' || url.pathname !== '/ws') {
      this.onError(new Error('Invalid EventSub reconnect URL'));
      return;
    }
    const previous = this.socket,
      socket = new WebSocket(address);
    this.socket = socket;
    this.lastBeat = Date.now();
    socket.addEventListener('message', (event) => {
      void (async () => {
        if (typeof event.data !== 'string' || event.data.length > 256000)
          throw new Error('Invalid EventSub message');
        const data = JSON.parse(event.data) as {
          metadata: { message_type: string; subscription_type?: string };
          payload: {
            session?: { id: string; keepalive_timeout_seconds?: number; reconnect_url?: string };
            event?: { broadcaster_user_login?: string };
          };
        };
        this.lastBeat = Date.now();
        if (data.metadata.message_type === 'session_welcome') {
          this.failures = 0;
          this.deadline = ((data.payload.session?.keepalive_timeout_seconds || 30) + 15) * 1000;
          if (migrate) previous?.close();
          else await this.subscribe(data.payload.session!.id);
        } else if (data.metadata.message_type === 'session_reconnect' && data.payload.session?.reconnect_url)
          this.connect(data.payload.session.reconnect_url, true);
        else if (data.metadata.message_type === 'notification' && data.payload.event?.broadcaster_user_login)
          await this.notify(
            data.payload.event.broadcaster_user_login,
            data.metadata.subscription_type === 'stream.offline',
          );
        else if (data.metadata.message_type === 'revocation')
          this.onError(new Error('EventSub subscription revoked; reconnect the Twitch account'));
      })().catch(this.onError);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.next = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6));
    });
    socket.addEventListener('error', () => {
      if (!this.stopped) this.onError(new Error('EventSub socket error'));
    });
  }
  private async subscribe(session: string) {
    const token = await this.providers.token('twitch'),
      headers = { 'Client-Id': process.env.TWITCH_CLIENT_ID || '', Authorization: 'Bearer ' + token };
    const response = await fetch(
      'https://api.twitch.tv/helix/users?' +
        this.names.map((name) => 'login=' + encodeURIComponent(name)).join('&'),
      { headers, signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) throw new Error('EventSub: cannot resolve users');
    const data = JSON.parse(await limitedResponse(response)) as { data: { id: string }[] };
    await Promise.all(
      data.data.flatMap((user) =>
        ['stream.online', 'stream.offline'].map(async (type) => {
          const response = await fetch('https://api.twitch.tv/helix/eventsub/subscriptions', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: JSON.stringify({
              type,
              version: '1',
              condition: { broadcaster_user_id: user.id },
              transport: { method: 'websocket', session_id: session },
            }),
            signal: AbortSignal.timeout(10000),
          });
          if (!response.ok && response.status !== 409)
            throw new Error('EventSub subscription HTTP ' + response.status);
        }),
      ),
    );
  }
  stop() {
    this.stopped = true;
    this.socket?.close();
    this.socket = undefined;
  }
}
