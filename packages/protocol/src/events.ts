import { getEventHash, verifyEvent } from 'nostr-tools/pure';
import { canonicalJson } from './canonical-json.ts';
import { HEX128, HEX64, utf8Length } from './hash.ts';
import type { Issue, NostrEvent } from './types.ts';

const issue = (code: string, message: string): Issue => ({ code, message });

/** Structural NIP-01 check. Returns a fresh plain copy so no cached verification state leaks in. */
export function parseEventShape(input: unknown): { event?: NostrEvent; errors: Issue[] } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { errors: [issue('malformed_event', 'event is not an object')] };
  }
  const e = input as Record<string, unknown>;
  const errors: Issue[] = [];
  if (typeof e.id !== 'string' || !HEX64.test(e.id)) errors.push(issue('malformed_event', 'id must be 64 lowercase hex'));
  if (typeof e.pubkey !== 'string' || !HEX64.test(e.pubkey)) errors.push(issue('malformed_event', 'pubkey must be 64 lowercase hex'));
  if (typeof e.sig !== 'string' || !HEX128.test(e.sig)) errors.push(issue('malformed_event', 'sig must be 128 lowercase hex'));
  if (!Number.isSafeInteger(e.kind) || (e.kind as number) < 0) errors.push(issue('malformed_event', 'kind must be a non-negative integer'));
  if (!Number.isSafeInteger(e.created_at) || (e.created_at as number) < 0) errors.push(issue('malformed_event', 'created_at must be a non-negative integer'));
  if (typeof e.content !== 'string') errors.push(issue('malformed_event', 'content must be a string'));
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.length > 0 && t.every((v) => typeof v === 'string'))) {
    errors.push(issue('malformed_event', 'tags must be an array of non-empty string arrays'));
  }
  if (errors.length) return { errors };
  const event: NostrEvent = {
    id: e.id as string,
    pubkey: e.pubkey as string,
    created_at: e.created_at as number,
    kind: e.kind as number,
    tags: (e.tags as string[][]).map((t) => [...t]),
    content: e.content as string,
    sig: e.sig as string,
  };
  return { event, errors: [] };
}

/** Recompute the NIP-01 event ID and check the Schnorr signature. */
export function checkSignature(event: NostrEvent): Issue[] {
  if (getEventHash(event) !== event.id) return [issue('bad_id', 'event id does not match its serialized content')];
  if (!verifyEvent({ ...event })) return [issue('bad_signature', 'signature does not verify for pubkey')];
  return [];
}

/** Deterministic envelope serialization used in archives and portable event files. */
export const serializeEnvelope = (event: NostrEvent): string => canonicalJson(event);

export const eventByteLength = (event: NostrEvent): number => utf8Length(JSON.stringify(event));

export const tagValues = (event: Pick<NostrEvent, 'tags'>, name: string): string[] =>
  event.tags.filter((t) => t[0] === name).map((t) => t[1] ?? '');

export const tagEntries = (event: Pick<NostrEvent, 'tags'>, name: string): string[][] => event.tags.filter((t) => t[0] === name);
