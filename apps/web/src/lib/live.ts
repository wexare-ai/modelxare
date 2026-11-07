// Live discovery: the browser talks to each configured relay directly. Events
// are verified in the catalog worker before they enter the local catalog.
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { CATALOG_TAG, FILE_METADATA_KIND, releaseRelayFilter, type NostrEvent } from '@wexare/protocol';
import type { CatalogClient } from './catalog-client.ts';

export interface RelayLiveState {
  url: string;
  status: 'idle' | 'connecting' | 'catching-up' | 'live' | 'closed' | 'error';
  error?: string;
  /** When the next connection attempt starts, while waiting to retry. */
  retryAt?: number;
  received: number;
  accepted: number;
  duplicates: number;
  rejected: number;
  unknownProfile: number;
  announcements: number;
  connectedAt?: number;
  eoseAt?: number;
}

export interface Rejection {
  relay: string;
  id: string;
  code: string;
  message: string;
  at: number;
}

export class LiveDiscovery extends EventTarget {
  readonly states = new Map<string, RelayLiveState>();
  readonly announcements = new Map<string, { event: NostrEvent; relays: Set<string> }>();
  readonly rejections: Rejection[] = [];
  private relays = new Map<string, AbstractRelay>();
  private buffers = new Map<string, unknown[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private authors: string[] | undefined;
  private running = false;
  private retries = new Map<string, ReturnType<typeof setTimeout>>();
  private attempts = new Map<string, number>();
  private readonly onOnline = () => {
    for (const url of [...this.retries.keys()]) {
      clearTimeout(this.retries.get(url));
      this.retries.delete(url);
      void this.connect(url);
    }
  };

  constructor(private readonly catalog: CatalogClient) {
    super();
  }

  private changed() {
    this.dispatchEvent(new Event('change'));
  }

  private set(url: string, patch: Partial<RelayLiveState>) {
    const s = this.states.get(url) ?? { url, status: 'idle', received: 0, accepted: 0, duplicates: 0, rejected: 0, unknownProfile: 0, announcements: 0 };
    this.states.set(url, { ...s, ...patch });
    this.changed();
  }

  /**
   * Stay connected to each relay: a relay that can't be reached, or drops the
   * connection (restarts, idle timeouts, a phone waking up), is tried again.
   * `authors`: ask relays only for these publishers' releases (all when absent).
   */
  start(urls: string[], opts: { authors?: string[] } = {}): void {
    this.stop();
    this.running = true;
    this.authors = opts.authors;
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);
    for (const url of urls) void this.connect(url);
    this.timer = setInterval(() => void this.flush(), 300);
  }

  stop(): void {
    this.running = false;
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
    this.attempts.clear();
    const open = [...this.relays];
    this.relays.clear();
    for (const [url, r] of open) {
      r.close();
      this.set(url, { status: 'idle' });
    }
  }

  /** Try again after 2 s, 4 s, 8 s … up to a minute, spread out so browsers don't all return at once. */
  private retry(url: string) {
    if (!this.running || this.retries.has(url)) return;
    const n = this.attempts.get(url) ?? 0;
    this.attempts.set(url, n + 1);
    const delay = Math.round(Math.min(60_000, 2_000 * 2 ** n) * (0.75 + Math.random() * 0.5));
    this.set(url, { retryAt: Date.now() + delay });
    this.retries.set(
      url,
      setTimeout(() => {
        this.retries.delete(url);
        void this.connect(url);
      }, delay),
    );
  }

  private async connect(url: string) {
    if (!this.running) return;
    this.set(url, { status: 'connecting', error: undefined, retryAt: undefined });
    // Pings find a connection that died silently, so it closes and is retried.
    const relay = new AbstractRelay(url, { verifyEvent: () => true, enablePing: true });
    try {
      await relay.connect({ timeout: 8000 });
    } catch (e) {
      this.set(url, { status: 'error', error: (e as Error).message || String(e) || 'connection failed' });
      this.retry(url);
      return;
    }
    if (!this.running) return relay.close();
    this.relays.set(url, relay);
    relay.onclose = () => {
      if (this.relays.get(url) !== relay) return;
      this.relays.delete(url);
      this.set(url, { status: 'closed' });
      this.retry(url);
    };
    this.set(url, { status: 'catching-up', connectedAt: Date.now() });
    const push = (e: unknown) => {
      const b = this.buffers.get(url) ?? [];
      b.push(e);
      this.buffers.set(url, b);
    };
    relay.subscribe([releaseRelayFilter({ limit: 1000, ...(this.authors ? { authors: this.authors } : {}) }) as never, { kinds: [FILE_METADATA_KIND], '#t': [CATALOG_TAG], limit: 100 }], {
      onevent: push,
      oninvalidevent: push,
      oneose: () => {
        // Caught up: a later drop starts again from the shortest wait.
        this.attempts.delete(url);
        this.set(url, { status: 'live', eoseAt: Date.now() });
      },
      onclose: (reason) => reason && this.set(url, { status: 'closed', error: reason }),
    });
  }

  private async flush() {
    for (const [url, batch] of this.buffers) {
      if (!batch.length) continue;
      this.buffers.set(url, []);
      try {
        const r = await this.catalog.ingestEvents(url, batch);
        const s = this.states.get(url)!;
        for (const a of r.catalogAnnouncements) {
          const entry = this.announcements.get(a.id) ?? { event: a, relays: new Set<string>() };
          entry.relays.add(url);
          this.announcements.set(a.id, entry);
        }
        for (const x of r.rejected) {
          this.rejections.unshift({ relay: url, ...x, at: Date.now() });
        }
        this.rejections.splice(100);
        this.set(url, {
          received: s.received + batch.length,
          accepted: s.accepted + r.accepted,
          duplicates: s.duplicates + r.duplicates,
          rejected: s.rejected + r.rejected.length,
          unknownProfile: s.unknownProfile + r.unknownProfile,
          announcements: s.announcements + r.catalogAnnouncements.length,
        });
        this.dispatchEvent(new Event('catalog-updated'));
      } catch (e) {
        console.error('ingest failed', e);
      }
    }
  }

  /** Look up one event by ID on the configured relays (e.g. an archive announcement). */
  async lookupEvent(id: string, urls: string[]): Promise<{ event: NostrEvent; relay: string } | null> {
    const tryRelay = async (url: string) => {
      const relay = this.relays.get(url) ?? (await AbstractRelay.connect(url, { verifyEvent: () => true }));
      return await new Promise<{ event: NostrEvent; relay: string } | null>((resolve) => {
        let found: NostrEvent | null = null;
        const sub = relay.subscribe([{ ids: [id] }], {
          onevent: (e) => (found = e as NostrEvent),
          oneose: () => {
            sub.close();
            if (!this.relays.has(url)) relay.close();
            resolve(found ? { event: found, relay: url } : null);
          },
          eoseTimeout: 6000,
        });
      });
    };
    for (const url of urls) {
      try {
        const r = await tryRelay(url);
        if (r) return r;
      } catch {
        // try the next relay
      }
    }
    return null;
  }
}
