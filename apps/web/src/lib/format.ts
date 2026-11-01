import { npubEncode } from 'nostr-tools/nip19';
export { formatBytes } from '@wexare/storage';

/** Short, human-checkable publisher fingerprint (never a trust badge). */
export function fingerprint(pubkey: string): string {
  try {
    const n = npubEncode(pubkey);
    return `${n.slice(0, 12)}…${n.slice(-6)}`;
  } catch {
    return `${pubkey.slice(0, 8)}…`;
  }
}
export const npub = (pubkey: string) => {
  try {
    return npubEncode(pubkey);
  } catch {
    return pubkey;
  }
};
export const shortId = (id: string, n = 12) => `${id.slice(0, n)}…`;
export const when = (unix: number | null | undefined) => (unix ? new Date(unix * 1000).toLocaleString() : '—');
export const ms = (v: number | undefined | null) => (v === undefined || v === null ? '—' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);
