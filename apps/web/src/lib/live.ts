// Live discovery: the browser talks to each configured relay directly. Events
// are verified in the catalog worker before they enter the local catalog.
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { CATALOG_TAG, FILE_METADATA_KIND, releaseRelayFilter, type NostrEvent } from '@wexare/protocol';
import type { CatalogClient } from './catalog-client.ts';

export interface RelayLiveState {
  url: string;
  status: 'idle' | 'connecting' | 'catching-up' | 'live' | 'closed' | 'error';
  error?: string;
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

  /** `authors`: ask relays only for these publishers' releases (all when absent). */
  start(urls: string[], opts: { authors?: string[] } = {}): void {
    this.stop();
    this.authors = opts.authors;
    for (const url of urls) void this.connect(url);
    this.timer = setInterval(() => void this.flush(), 300);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [url, r] of this.relays) {
      r.close();
      this.set(url, { status: 'idle' });
    }
    this.relays.clear();
  }

  private async connect(url: string) {
    this.set(url, { status: 'connecting', error: undefined });
    const relay = new AbstractRelay(url, { verifyEvent: () => true });
    try {
      await relay.connect({ timeout: 8000 });
    } catch (e) {
      this.set(url, { status: 'error', error: (e as Error).message || 'connection failed' });
      return;
    }
    this.relays.set(url, relay);
    relay.onclose = () => this.set(url, { status: 'closed' });
    this.set(url, { status: 'catching-up', connectedAt: Date.now() });
    const push = (e: unknown) => {
      const b = this.buffers.get(url) ?? [];
      b.push(e);
      this.buffers.set(url, b);
    };
    relay.subscribe([releaseRelayFilter({ limit: 1000, ...(this.authors ? { authors: this.authors } : {}) }) as never, { kinds: [FILE_METADATA_KIND], '#t': [CATALOG_TAG], limit: 100 }], {
      onevent: push,
      oninvalidevent: push,
      oneose: () => this.set(url, { status: 'live', eoseAt: Date.now() }),
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
