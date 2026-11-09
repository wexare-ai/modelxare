// Releases on this machine: signed release events read from relays, kept in
// the data folder so the runtime starts (and serves downloaded models) without
// a network, and checked again every time they are read: a stored event that
// no longer verifies is dropped, never trusted because it was once fetched.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { releaseRelayFilter, verifyReleaseEvent, type NostrEvent, type VerifiedRelease } from '@wexare/protocol';

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

export interface RelayRead {
  relay: string;
  /** Events the relay sent, valid or not. */
  received: number;
  /** Valid releases not seen before. */
  added: number;
  rejected: number;
  error?: string;
  ms: number;
}

/** One relay's releases, until it says it sent them all (EOSE) or the time is up. */
export async function readRelay(url: string, authors: string[] | undefined, timeoutMs: number): Promise<{ events: unknown[]; error?: string }> {
  let relay: AbstractRelay;
  try {
    relay = new AbstractRelay(url, { verifyEvent: () => true, websocketImplementation: SafeWebSocket as typeof WebSocket });
    await relay.connect({ timeout: timeoutMs });
  } catch (e) {
    return { events: [], error: (e as Error).message || 'connection failed' };
  }
  try {
    const filter = releaseRelayFilter({ limit: 500, ...(authors ? { authors } : {}) });
    return await new Promise((resolve) => {
      const events: unknown[] = [];
      const sub = relay.subscribe([filter as never], {
        onevent: (e) => void events.push(e),
        oneose: () => {
          sub.close();
          resolve({ events });
        },
        onclose: (reason) => resolve({ events, ...(events.length ? {} : { error: reason || 'closed' }) }),
        eoseTimeout: timeoutMs,
      });
    });
  } finally {
    relay.close();
  }
}

interface StoreFile {
  schema: 'wexare.local.releases/0.1';
  events: NostrEvent[];
}

/** Signed release events kept in one JSON file. */
export class ReleaseStore {
  private events = new Map<string, NostrEvent>();

  constructor(readonly path: string) {
    if (!existsSync(path)) return;
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as StoreFile;
      for (const e of file.events ?? []) if (typeof e?.id === 'string') this.events.set(e.id, e);
    } catch {
      // A damaged file is rebuilt from the relays on the next sync.
    }
  }

  get size(): number {
    return this.events.size;
  }

  /** Every stored event that still verifies. */
  verified(): VerifiedRelease[] {
    const out: VerifiedRelease[] = [];
    for (const e of this.events.values()) {
      const r = verifyReleaseEvent(e);
      if (r.ok) out.push(r.value);
    }
    return out;
  }

  /** Keep the events that verify; returns how many were new, and how many failed. */
  add(events: unknown[]): { added: number; rejected: number } {
    let added = 0;
    let rejected = 0;
    for (const raw of events) {
      const r = verifyReleaseEvent(raw);
      if (!r.ok) {
        rejected++;
        continue;
      }
      if (this.events.has(r.value.event.id)) continue;
      this.events.set(r.value.event.id, r.value.event);
      added++;
    }
    return { added, rejected };
  }

  save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const file: StoreFile = { schema: 'wexare.local.releases/0.1', events: [...this.events.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)) };
    writeFileSync(`${this.path}.tmp`, JSON.stringify(file, null, 1));
    renameSync(`${this.path}.tmp`, this.path);
  }
}

/** Read every relay at once and keep what verifies. */
export async function syncReleases(store: ReleaseStore, relays: string[], authors: string[] | undefined, timeoutMs = 10_000): Promise<RelayRead[]> {
  const reads = await Promise.all(
    relays.map(async (relay): Promise<RelayRead> => {
      const t0 = Date.now();
      const { events, error } = await readRelay(relay, authors, timeoutMs);
      const { added, rejected } = store.add(events);
      return { relay, received: events.length, added, rejected, ...(error ? { error } : {}), ms: Date.now() - t0 };
    }),
  );
  store.save();
  return reads;
}
