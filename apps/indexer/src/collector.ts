import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { CatalogStore, OperatorStore, sourceIdFor } from '@wexare/catalog';
import { CATALOG_TAG, OTHER_RELEASE_VERSION, RELEASE_TAG, releaseRelayFilter, verifyReleaseEvent, type NostrEvent } from '@wexare/protocol';

/**
 * Node's built-in WebSocket fires `error` synchronously from close() during the
 * handshake, and nostr-tools calls close() from onerror: guard the re-entry.
 */
class SafeWebSocket extends WebSocket {
  private closing = false;
  override close(code?: number, reason?: string): void {
    if (this.closing) return;
    this.closing = true;
    super.close(code, reason);
  }
}

export interface CollectorOptions {
  /** How far back a first catch-up (or a rescan) reaches. */
  historyWindowSeconds: number;
  /** Re-read this much before the stored cursor on every reconnect. */
  overlapSeconds: number;
  /** Requested page size; relays may silently return fewer. */
  pageLimit: number;
  maxEventBytes: number;
  eoseTimeoutMs: number;
  connectTimeoutMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_COLLECTOR_OPTIONS: CollectorOptions = {
  historyWindowSeconds: 10 * 365 * 24 * 3600,
  overlapSeconds: 600,
  pageLimit: 500,
  maxEventBytes: 32 * 1024,
  eoseTimeoutMs: 15_000,
  connectTimeoutMs: 10_000,
  maxBackoffMs: 60_000,
};

export interface CatchUpResult {
  complete: boolean;
  pages: number;
  received: number;
  gaps: number[];
  startedAt: number;
}

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

/**
 * Collects release announcements from one relay: paginated catch-up from the
 * stored cursor (minus an overlap window), then a live subscription.
 * EOSE only means this relay finished this response; it never proves global
 * completeness, and truncated responses are reported, not skipped over.
 */
export class RelayCollector {
  private relay: AbstractRelay | null = null;
  private readonly abort = new AbortController();
  private attempt = 0;
  private relayLimit: number | null = null;

  constructor(
    readonly url: string,
    private readonly store: CatalogStore,
    private readonly op: OperatorStore,
    private readonly opts: CollectorOptions,
    private readonly log: (msg: string) => void = (m) => console.log(m),
  ) {
    op.ensureRelay(url);
    store.upsertSource({ id: sourceIdFor.relay(url), type: 'relay', label: url, url });
  }

  /** Verify and store one event; returns the outcome counter name. */
  handle(raw: unknown): 'accepted_new' | 'duplicates' | 'rejected' | 'unknown_profile' | 'catalog_ignored' {
    this.op.bump(this.url, 'events_received');
    const tags = (raw as NostrEvent)?.tags;
    const t = Array.isArray(tags) ? tags.filter((x) => Array.isArray(x) && x[0] === 't').map((x) => x[1]) : [];
    let outcome: ReturnType<RelayCollector['handle']>;
    if (t.includes(CATALOG_TAG)) outcome = 'catalog_ignored';
    else if (!t.includes(RELEASE_TAG)) outcome = 'unknown_profile';
    else {
      const r = verifyReleaseEvent(raw, { maxEventBytes: this.opts.maxEventBytes });
      if (!r.ok && r.errors[0]!.code === OTHER_RELEASE_VERSION) outcome = 'unknown_profile';
      else if (!r.ok) {
        outcome = 'rejected';
        const id = typeof (raw as NostrEvent)?.id === 'string' ? (raw as NostrEvent).id.slice(0, 64) : 'unknown';
        this.op.recordRejection(this.url, id, r.errors[0]!.code, r.errors.map((e) => e.message).join('; '));
      } else {
        outcome = this.store.addVerifiedRelease(r.value, sourceIdFor.relay(this.url)) ? 'accepted_new' : 'duplicates';
      }
    }
    this.op.bump(this.url, outcome);
    return outcome;
  }

  private async connect(): Promise<AbstractRelay> {
    const relay = new AbstractRelay(this.url, { verifyEvent: () => true, websocketImplementation: SafeWebSocket as typeof WebSocket, enablePing: true });
    relay.publishTimeout = this.opts.eoseTimeoutMs;
    await relay.connect({ timeout: this.opts.connectTimeoutMs, abort: this.abort.signal });
    return relay;
  }

  /** NIP-11 relay information: use an advertised max_limit when available. */
  private async readRelayLimit(): Promise<void> {
    try {
      const res = await fetch(this.url.replace(/^ws/, 'http'), { headers: { Accept: 'application/nostr+json' }, signal: AbortSignal.timeout(3000) });
      const info = (await res.json()) as { limitation?: { max_limit?: number } };
      const l = info.limitation?.max_limit;
      if (typeof l === 'number' && l > 0) this.relayLimit = l;
    } catch {
      // Not advertised: truncation is detected empirically below.
    }
  }

  private fetchPage(relay: AbstractRelay, filter: Record<string, unknown>): Promise<{ events: unknown[]; eose: boolean }> {
    return new Promise((resolve) => {
      const events: unknown[] = [];
      let done = false;
      const finish = (eose: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sub.close();
        resolve({ events, eose });
      };
      const timer = setTimeout(() => finish(false), this.opts.eoseTimeoutMs);
      const sub = relay.subscribe([filter as never], {
        onevent: (e) => events.push(e),
        oninvalidevent: (e) => events.push(e),
        oneose: () => finish(true),
        onclose: () => finish(false),
        eoseTimeout: this.opts.eoseTimeoutMs + 1000,
      });
    });
  }

  /**
   * Page backwards through [since, now]. Pages shorter than the cap are
   * confirmed with one more request, because a relay may cap responses below
   * the requested limit without saying so.
   */
  async catchUp(relay: AbstractRelay, since: number): Promise<CatchUpResult> {
    const startedAt = now();
    let until = startedAt;
    let cap = Math.min(this.opts.pageLimit, this.relayLimit ?? Infinity);
    let complete = true;
    let pages = 0;
    let received = 0;
    const gaps: number[] = [];
    const seen = new Set<string>();
    // A short page is only trusted after a confirmation request brings nothing new.
    let pending: { count: number; minTs: number; tied: boolean } | null = null;
    const gapAt = (ts: number, why: string) => {
      complete = false;
      gaps.push(ts);
      this.op.markIncomplete(this.url, why);
      this.op.log('warn', 'tied_timestamp_saturation', why, this.url);
    };
    while (pages < 100_000) {
      if (this.abort.signal.aborted) return { complete: false, pages, received, gaps, startedAt };
      const { events, eose } = await this.fetchPage(relay, releaseRelayFilter({ since, until, limit: this.opts.pageLimit }) as never);
      pages++;
      received += events.length;
      let fresh = 0;
      for (const e of events) {
        const id = (e as NostrEvent)?.id;
        if (typeof id === 'string' && !seen.has(id)) {
          seen.add(id);
          fresh++;
        }
        this.handle(e);
      }
      if (!eose) {
        complete = false;
        this.op.markIncomplete(this.url, `no end-of-stored-events for page until=${until}`);
        break;
      }
      if (pending) {
        if (fresh === 0) break; // confirmation found nothing new: the short page was the end
        // The short page was truncated: the relay's real cap is its length.
        cap = Math.max(1, pending.count);
        this.op.log('warn', 'relay_cap_detected', `relay returned at most ${cap} events per request`, this.url);
        if (pending.tied) gapAt(pending.minTs, `response limit (${cap}) reached with every event at created_at=${pending.minTs}; more may exist at that timestamp`);
        pending = null;
      }
      if (events.length === 0) break;
      const ts = events.map((e) => (e as NostrEvent).created_at).filter((n) => Number.isSafeInteger(n));
      const minTs = Math.min(...ts);
      const maxTs = Math.max(...ts);
      if (events.length >= cap) {
        if (minTs < until) {
          until = minTs; // inclusive: ties at minTs are fetched again and deduplicated
          continue;
        }
        // A full page at one timestamp: the relay may hold more events at `until` than it returns.
        gapAt(until, `response limit (${cap}) reached with every event at created_at=${until}; more may exist at that timestamp`);
        until -= 1;
      } else {
        pending = { count: events.length, minTs, tied: minTs === maxTs };
        // All-tied short page: anything strictly older proves truncation.
        until = pending.tied ? minTs - 1 : minTs;
      }
      if (until < since) break;
    }
    return { complete, pages, received, gaps, startedAt };
  }

  /** Full rescan over the configured history window, ignoring the cursor. */
  async rescan(historySeconds = this.opts.historyWindowSeconds): Promise<CatchUpResult> {
    const relay = await this.connect();
    try {
      await this.readRelayLimit();
      this.op.clearIncomplete(this.url);
      const r = await this.catchUp(relay, Math.max(0, now() - historySeconds));
      if (r.complete) this.op.completeCatchUp(this.url, r.startedAt);
      else if (r.gaps.length) this.op.completeCatchUp(this.url, Math.min(...r.gaps));
      return r;
    } finally {
      relay.close();
    }
  }

  /** Connect, catch up, stay live; reconnect with bounded exponential backoff. */
  async run(): Promise<void> {
    await this.readRelayLimit();
    while (!this.abort.signal.aborted) {
      this.op.setStatus(this.url, 'connecting');
      try {
        const relay = (this.relay = await this.connect());
        const closed = new Promise<void>((r) => (relay.onclose = () => r()));
        this.op.setStatus(this.url, 'catching-up', { connected: true });
        this.attempt = 0;
        const state = this.op.get(this.url);
        const since = state?.cursor ? Math.max(0, state.cursor - this.opts.overlapSeconds) : Math.max(0, now() - this.opts.historyWindowSeconds);
        const r = await this.catchUp(relay, since);
        if (r.complete) {
          this.op.completeCatchUp(this.url, r.startedAt);
          if (r.received) this.log(`[${this.url}] catch-up complete: ${r.received} events in ${r.pages} pages since ${since}`);
        } else {
          // Do not move the cursor past unseen records: resume at the earliest gap.
          if (r.gaps.length) this.op.completeCatchUp(this.url, Math.min(...r.gaps));
          this.op.setStatus(this.url, 'degraded', { connected: true });
          this.log(`[${this.url}] catch-up POSSIBLY INCOMPLETE (gaps at ${r.gaps.join(', ') || 'timeout'})`);
        }
        // Relays apply `since` to live events too, so an event signed earlier and published now
        // (a republish, or a release prepared ahead of time) would never arrive. The second filter
        // returns nothing stored (`limit: 0`) and matches every new event, whatever its created_at.
        const live = [releaseRelayFilter({ since: r.startedAt - this.opts.overlapSeconds }), releaseRelayFilter({ limit: 0 })];
        const sub = relay.subscribe(live as never, {
          onevent: (e) => this.handle(e),
          oninvalidevent: (e) => this.handle(e),
          oneose: () => {
            if (r.complete) this.op.setStatus(this.url, 'live', { connected: true });
          },
          onclose: (reason) => {
            if (!this.abort.signal.aborted && reason) {
              this.op.recordError(this.url, `subscription closed: ${reason}`);
              this.op.setStatus(this.url, 'degraded');
            }
          },
        });
        // While live, advance the cursor to now minus the overlap window.
        const tick = setInterval(() => {
          const s = this.op.get(this.url);
          if (s?.status === 'live') this.op.completeCatchUp(this.url, now() - this.opts.overlapSeconds);
        }, 30_000);
        await Promise.race([closed, new Promise((r) => this.abort.signal.addEventListener('abort', r, { once: true }))]);
        clearInterval(tick);
        sub.close();
        relay.close();
        if (!this.abort.signal.aborted) this.log(`[${this.url}] disconnected`);
      } catch (e) {
        if (!this.abort.signal.aborted) {
          // nostr-tools rejects a failed connect with a plain string, not an Error.
          const msg = (e instanceof Error ? e.message : String(e ?? '')) || 'connection failed';
          this.op.recordError(this.url, msg);
          const hint = this.attempt === 0 && /connection failed|websocket closed|ECONNREFUSED/i.test(msg) ? ' (is the relay running? pnpm infra:up)' : '';
          this.log(`[${this.url}] error: ${msg}${hint}`);
        }
      }
      this.relay = null;
      this.op.setStatus(this.url, 'disconnected');
      if (this.abort.signal.aborted) break;
      const backoff = Math.min(this.opts.maxBackoffMs, 1000 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
      this.attempt = Math.min(this.attempt + 1, 10);
      this.op.bump(this.url, 'reconnects');
      await sleep(backoff, this.abort.signal);
    }
  }

  stop(): void {
    this.abort.abort();
    this.relay?.close();
  }
}
