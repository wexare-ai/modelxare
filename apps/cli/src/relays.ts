import { AbstractRelay } from 'nostr-tools/abstract-relay';
import type { NostrEvent } from '@wexare/protocol';

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

export type PublishOutcome = 'accepted' | 'duplicate' | 'rejected' | 'timed-out' | 'disconnected';

export interface RelayPublishResult {
  relay: string;
  outcome: PublishOutcome;
  message: string;
  ms: number;
}

const connect = async (url: string, timeoutMs: number) => {
  const relay = new AbstractRelay(url, { verifyEvent: () => true, websocketImplementation: SafeWebSocket as typeof WebSocket });
  relay.publishTimeout = timeoutMs;
  await relay.connect({ timeout: timeoutMs });
  return relay;
};

/**
 * Publish the exact same signed event to each relay and report each relay's
 * acknowledgment separately. A local signature is not a relay acceptance.
 */
export async function publishToRelays(event: NostrEvent, relays: string[], timeoutMs = 8000): Promise<RelayPublishResult[]> {
  return Promise.all(
    relays.map(async (url): Promise<RelayPublishResult> => {
      const t0 = Date.now();
      let relay: AbstractRelay | undefined;
      try {
        relay = await connect(url, timeoutMs);
      } catch (e) {
        return { relay: url, outcome: 'disconnected', message: (e as Error).message || 'connection failed', ms: Date.now() - t0 };
      }
      try {
        const reason = await relay.publish(event as never);
        return { relay: url, outcome: /^duplicate:/.test(reason) ? 'duplicate' : 'accepted', message: reason || 'OK', ms: Date.now() - t0 };
      } catch (e) {
        const msg = (e as Error).message || String(e);
        const outcome: PublishOutcome = /timed out/i.test(msg) ? 'timed-out' : /closed|connection|SendingOnClosed/i.test(msg) ? 'disconnected' : 'rejected';
        return { relay: url, outcome, message: msg, ms: Date.now() - t0 };
      } finally {
        relay.close();
      }
    }),
  );
}

/** Publish many events to one relay over a single connection; counts outcomes. */
export async function publishManyToRelay(events: NostrEvent[], url: string, timeoutMs = 8000): Promise<Record<PublishOutcome, number> & { relay: string; firstError?: string }> {
  const counts = { relay: url, accepted: 0, duplicate: 0, rejected: 0, 'timed-out': 0, disconnected: 0 } as Record<PublishOutcome, number> & { relay: string; firstError?: string };
  let relay: AbstractRelay;
  try {
    relay = await connect(url, timeoutMs);
  } catch (e) {
    counts.disconnected = events.length;
    counts.firstError = (e as Error).message || 'connection failed';
    return counts;
  }
  try {
    for (const event of events) {
      try {
        const reason = await relay.publish(event as never);
        counts[/^duplicate:/.test(reason) ? 'duplicate' : 'accepted']++;
      } catch (e) {
        const msg = (e as Error).message || String(e);
        counts[/timed out/i.test(msg) ? 'timed-out' : /closed|connection|SendingOnClosed/i.test(msg) ? 'disconnected' : 'rejected']++;
        counts.firstError ??= msg;
      }
    }
  } finally {
    relay.close();
  }
  return counts;
}

/** One-shot query (until EOSE) used by verification commands. */
export async function queryRelay(url: string, filter: Record<string, unknown>, timeoutMs = 8000): Promise<NostrEvent[]> {
  const relay = await connect(url, timeoutMs);
  try {
    return await new Promise<NostrEvent[]>((resolve) => {
      const out: NostrEvent[] = [];
      const sub = relay.subscribe([filter as never], {
        onevent: (e) => out.push(e as NostrEvent),
        oneose: () => {
          sub.close();
          resolve(out);
        },
        eoseTimeout: timeoutMs,
      });
    });
  } finally {
    relay.close();
  }
}

export function printPublishResults(label: string, results: RelayPublishResult[]): void {
  console.log(`  ${label}`);
  for (const r of results) {
    const mark = r.outcome === 'accepted' || r.outcome === 'duplicate' ? '✓' : '✗';
    console.log(`    ${mark} ${r.relay.padEnd(24)} ${r.outcome.padEnd(12)} ${r.message} (${r.ms} ms)`);
  }
}
