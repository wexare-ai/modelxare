import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadClientConfig } from '../client-config.ts';

const KEY = 'ab'.repeat(32);

function publishersFile(publishers: unknown): string {
  const f = join(mkdtempSync(join(tmpdir(), 'wexare-publishers-')), 'publishers.json');
  writeFileSync(f, JSON.stringify({ publishers }));
  return f;
}

const deployment = (extra: Record<string, string> = {}) => ({
  WEXARE_RELAYS: 'wss://relay.example.org, wss://relay2.example.org',
  WEXARE_IPFS_GATEWAYS: 'https://ipfs.example.org',
  WEXARE_PUBLISHERS: publishersFile([{ pubkey: KEY, label: 'Example', approvedBy: 'Example', roles: ['models', 'router'] }]),
  ...extra,
});

describe('client config', () => {
  it('uses the local development services, showing every publisher, when nothing is set', () => {
    const c = loadClientConfig({});
    expect(c.publishers).toBe('any');
    expect(c.relays.every((r) => r.startsWith('ws://127.0.0.1'))).toBe(true);
  });

  it('takes every address from the environment', () => {
    const c = loadClientConfig(deployment({ WEXARE_APPROVAL_REQUEST: 'mailto:models@example.org' }));
    expect(c.relays).toEqual(['wss://relay.example.org', 'wss://relay2.example.org']);
    expect(c.ipfsGateways).toEqual(['https://ipfs.example.org']);
    expect(c.trackers).toEqual([]);
    expect(c.approvalRequest).toBe('mailto:models@example.org');
    expect(c.publishers).toEqual([{ pubkey: KEY, label: 'Example', approvedBy: 'Example', roles: ['models', 'router'] }]);
  });

  it('refuses insecure or missing addresses', () => {
    expect(() => loadClientConfig(deployment({ WEXARE_RELAYS: 'ws://relay.example.org' }))).toThrow(/WEXARE_RELAYS: "ws:\/\/relay.example.org" isn't a wss:\/\/ URL/);
    expect(() => loadClientConfig(deployment({ WEXARE_RELAYS: '' }))).toThrow(/WEXARE_RELAYS: required/);
    expect(() => loadClientConfig(deployment({ WEXARE_IPFS_GATEWAYS: 'http://ipfs.example.org' }))).toThrow(/WEXARE_IPFS_GATEWAYS/);
    // Optional: releases whose files are only on HTTPS hosts need no gateway.
    expect(loadClientConfig(deployment({ WEXARE_IPFS_GATEWAYS: '' })).ipfsGateways).toEqual([]);
    expect(() => loadClientConfig(deployment({ WEXARE_APPROVAL_REQUEST: 'javascript:alert(1)' }))).toThrow(/WEXARE_APPROVAL_REQUEST/);
  });

  it('never deploys without approved publishers, or with a malformed one', () => {
    expect(() => loadClientConfig(deployment({ WEXARE_PUBLISHERS: publishersFile([]) }))).toThrow(/at least one approved publisher/);
    expect(() => loadClientConfig(deployment({ WEXARE_PUBLISHERS: publishersFile([{ pubkey: 'npub1xyz', label: 'X', approvedBy: 'X', roles: ['models'] }]) }))).toThrow(/64 lowercase hex/);
    expect(() => loadClientConfig(deployment({ WEXARE_PUBLISHERS: publishersFile([{ pubkey: KEY, label: 'X', approvedBy: 'X', roles: ['admin'] }]) }))).toThrow(/roles/);
    expect(() => loadClientConfig(deployment({ WEXARE_PUBLISHERS: '/nonexistent/publishers.json' }))).toThrow(/can't read/);
  });

  it('the repository’s publishers file is well formed', () => {
    const { publishers } = JSON.parse(readFileSync(join(import.meta.dirname, '../../../infra/publishers.json'), 'utf8'));
    expect(Array.isArray(publishers)).toBe(true);
    // Until weXare's production key is listed, a deployment build refuses to run.
    const build = () => loadClientConfig({ WEXARE_RELAYS: 'wss://relay.example.org', WEXARE_IPFS_GATEWAYS: 'https://ipfs.example.org' });
    if (publishers.length) expect(build).not.toThrow();
    else expect(build).toThrow(/at least one approved publisher/);
  });
});
