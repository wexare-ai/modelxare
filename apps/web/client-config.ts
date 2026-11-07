// Build-time choice of what the apps connect to (used by both vite configs).
//
// No WEXARE_* variables: the local development services in
// infra/dev-endpoints.json, showing every validly signed release.
//
// A deployment sets them in its build environment (on Vercel: Project →
// Settings → Environment Variables; see infra/deploy/app.env.example):
//   WEXARE_RELAYS                wss:// URLs, comma-separated (required)
//   WEXARE_IPFS_GATEWAYS         https:// URLs, for ipfs:// file locations
//   WEXARE_TRACKERS              wss:// WebTorrent trackers (none: no torrents)
//   WEXARE_ARWEAVE_GATEWAYS      https:// URLs
//   WEXARE_OPERATOR_STATUS_URLS  https:// URLs
//   WEXARE_APPROVAL_REQUEST      https:// or mailto: link for new publishers
//   WEXARE_PUBLISHERS            approved publishers file, relative to the repo
//                                root (default infra/publishers.json)
// It is checked here, so a broken setting fails the build instead of shipping.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { ClientConfig, PublisherApproval } from './src/lib/client-config.ts';

const ROOT = join(import.meta.dirname, '../..');

const VARS = ['WEXARE_RELAYS', 'WEXARE_IPFS_GATEWAYS', 'WEXARE_TRACKERS', 'WEXARE_ARWEAVE_GATEWAYS', 'WEXARE_OPERATOR_STATUS_URLS', 'WEXARE_APPROVAL_REQUEST', 'WEXARE_PUBLISHERS'];

const urls = (v: string | undefined) => (v ?? '').split(/[\s,]+/).filter(Boolean);

export function loadClientConfig(env: Record<string, string | undefined> = process.env): ClientConfig {
  if (!VARS.some((v) => env[v]?.trim())) {
    const dev = JSON.parse(readFileSync(join(ROOT, 'infra/dev-endpoints.json'), 'utf8'));
    return {
      relays: dev.relays,
      ipfsGateways: [dev.kubo.a.gateway, dev.kubo.b.gateway],
      arweaveGateways: dev.arweaveGateways,
      trackers: [dev.tracker.ws],
      operatorStatusUrls: [dev.indexer.status, dev.indexer2.status],
      publishers: 'any',
    };
  }
  const publishersFile = env.WEXARE_PUBLISHERS?.trim() || 'infra/publishers.json';
  let publishers: unknown;
  try {
    publishers = JSON.parse(readFileSync(isAbsolute(publishersFile) ? publishersFile : join(ROOT, publishersFile), 'utf8')).publishers;
  } catch (e) {
    throw new Error(`WEXARE_PUBLISHERS: can't read ${publishersFile}: ${(e as Error).message}`);
  }
  const config = {
    relays: urls(env.WEXARE_RELAYS),
    ipfsGateways: urls(env.WEXARE_IPFS_GATEWAYS),
    arweaveGateways: urls(env.WEXARE_ARWEAVE_GATEWAYS),
    trackers: urls(env.WEXARE_TRACKERS),
    operatorStatusUrls: urls(env.WEXARE_OPERATOR_STATUS_URLS),
    publishers: publishers as PublisherApproval[],
    ...(env.WEXARE_APPROVAL_REQUEST?.trim() ? { approvalRequest: env.WEXARE_APPROVAL_REQUEST.trim() } : {}),
  };
  const problems = checkDeployment(config, publishersFile);
  if (problems.length) throw new Error(`This build's WEXARE_* settings can't be deployed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return { ...config, publishers: config.publishers.map((p) => ({ pubkey: p.pubkey, label: p.label, approvedBy: p.approvedBy, roles: p.roles })) };
}

/** A deployed site is served over HTTPS, so every endpoint must be secure too. */
export function checkDeployment(c: Omit<ClientConfig, 'publishers'> & { publishers: unknown }, publishersFile = 'publishers'): string[] {
  const problems: string[] = [];
  const list = (name: string, values: string[], scheme: string, required: boolean) => {
    if (required && !values.length) problems.push(`${name}: required`);
    for (const u of values) {
      let ok = u.startsWith(scheme);
      try {
        ok &&= !!new URL(u).hostname;
      } catch {
        ok = false;
      }
      if (!ok) problems.push(`${name}: ${JSON.stringify(u)} isn't a ${scheme} URL`);
    }
  };
  list('WEXARE_RELAYS', c.relays, 'wss://', true);
  list('WEXARE_IPFS_GATEWAYS', c.ipfsGateways, 'https://', false);
  list('WEXARE_ARWEAVE_GATEWAYS', c.arweaveGateways, 'https://', false);
  list('WEXARE_TRACKERS', c.trackers, 'wss://', false);
  list('WEXARE_OPERATOR_STATUS_URLS', c.operatorStatusUrls, 'https://', false);
  if (c.approvalRequest !== undefined && !/^(https:\/\/|mailto:)\S+$/.test(c.approvalRequest)) problems.push('WEXARE_APPROVAL_REQUEST: must be an https:// or mailto: link');

  const publishers = c.publishers;
  if (!Array.isArray(publishers) || !publishers.length) {
    problems.push(`${publishersFile}: list at least one approved publisher (a deployed app never shows every publisher)`);
    return problems;
  }
  const seen = new Set<string>();
  for (const [i, p] of publishers.entries()) {
    const at = `${publishersFile}: publishers[${i}]`;
    if (typeof p?.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(p.pubkey)) problems.push(`${at}.pubkey: expected 64 lowercase hex characters (pnpm cli pubkey --key <file> prints it)`);
    else if (seen.has(p.pubkey)) problems.push(`${at}.pubkey: listed twice`);
    else seen.add(p.pubkey);
    if (typeof p?.label !== 'string' || !p.label.trim()) problems.push(`${at}.label: expected the name people see`);
    if (typeof p?.approvedBy !== 'string' || !p.approvedBy.trim()) problems.push(`${at}.approvedBy: expected who vouches for this publisher`);
    if (!Array.isArray(p?.roles) || !p.roles.length || p.roles.some((r: unknown) => r !== 'models' && r !== 'router')) problems.push(`${at}.roles: expected "models" and/or "router"`);
  }
  return problems;
}
