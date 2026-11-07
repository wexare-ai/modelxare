#!/usr/bin/env node
// strfry write policy for a public modelXare relay (strfry runs it as a plugin:
// one JSON request per line in, one decision per line out). It keeps only
// modelXare releases and catalog announcements, and refuses an address that
// sends more than RELAY_EVENTS_PER_MINUTE events. Anyone may publish: which
// publishers an app shows is the app's choice (its approved publishers), and
// every browser verifies each release itself.
import { createInterface } from 'node:readline';

const TAGS = new Set(['wexare-micromodel', 'wexare-micromodel-catalog']);
const PER_MINUTE = Number(process.env.RELAY_EVENTS_PER_MINUTE) || 30;
const recent = new Map(); // address -> times of its recent events

function limited(address, now) {
  const times = (recent.get(address) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= PER_MINUTE) return true;
  times.push(now);
  recent.set(address, times);
  if (recent.size > 50_000) for (const [a, ts] of recent) if (now - ts[ts.length - 1] >= 60_000) recent.delete(a);
  return false;
}

for await (const line of createInterface({ input: process.stdin })) {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    continue;
  }
  const e = req.event ?? {};
  const decide = (action, msg = '') => process.stdout.write(`${JSON.stringify({ id: e.id, action, msg })}\n`);
  const ours = e.kind === 1063 && Array.isArray(e.tags) && e.tags.some((t) => Array.isArray(t) && t[0] === 't' && TAGS.has(t[1]));
  if (!ours) decide('reject', 'blocked: this relay only keeps modelXare releases (kind 1063, t=wexare-micromodel)');
  else if ((req.sourceType === 'IP4' || req.sourceType === 'IP6') && limited(req.sourceInfo, Date.now()))
    decide('reject', 'rate-limited: too many events from this address, try again in a minute');
  else decide('accept');
}
