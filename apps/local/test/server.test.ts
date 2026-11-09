// The API's guards and routes, with an engine that has no models: who may
// call it, what it refuses, and what clients that probe for other servers see.
// No model runs here.
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApi } from '../src/server.ts';
import { checkConfig, loadConfig } from '../src/config.ts';
import type { Engine } from '../src/engine.ts';

const empty = {
  options: { pullOnDemand: false },
  catalog: { models: [], router: null, skipped: [] },
  servable: () => [],
  model: () => undefined,
  isReady: () => false,
  generalModel: () => null,
  contextLength: async () => null,
} as unknown as Engine;

function start(opts: { apiKey?: string; corsOrigins?: string[] } = {}) {
  const server = createApi(empty, { host: '127.0.0.1', port: 0, ...opts });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() })),
  );
}

describe('the OpenAI-compatible API', () => {
  let api: { url: string; close: () => void };
  beforeAll(async () => (api = await start()));
  afterAll(() => api.close());

  it('lists no models when none is downloaded, and has a health check', async () => {
    expect(await (await fetch(`${api.url}/v1/models`)).json()).toEqual({ object: 'list', data: [] });
    expect((await (await fetch(`${api.url}/health`)).json()).status).toBe('ok');
  });

  it('answers unknown paths, including other servers’ probes, with a JSON 404', async () => {
    for (const path of ['/api/v1/models', '/api/tags', '/v1/props', '/v1/responses']) {
      const r = await fetch(`${api.url}${path}`);
      expect(r.status).toBe(404);
      expect((await r.json()).error.code).toBe('not_found');
    }
  });

  it('names a missing model in OpenAI’s error format', async () => {
    const r = await fetch(`${api.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-9', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(r.status).toBe(404);
    expect((await r.json()).error).toMatchObject({ type: 'invalid_request_error', param: 'model', code: 'model_not_found' });
  });

  it('only takes JSON bodies, so web pages cannot post to it without a preflight', async () => {
    const r = await fetch(`${api.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(r.status).toBe(415);
  });

  it('refuses web pages from other origins, and Host names other than localhost', async () => {
    expect((await fetch(`${api.url}/v1/models`, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => request(`${api.url}/v1/models`, { headers: { host: 'rebound.example:8796' } }, (res) => resolve(res.statusCode!)).end());
    expect(status).toBe(403);
  });
});

describe('with an API key and an allowed origin', () => {
  let api: { url: string; close: () => void };
  beforeAll(async () => (api = await start({ apiKey: 'secret-key', corsOrigins: ['http://localhost:3000'] })));
  afterAll(() => api.close());

  it('requires the key, except for the health check', async () => {
    expect((await fetch(`${api.url}/v1/models`)).status).toBe(401);
    expect((await fetch(`${api.url}/v1/models`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${api.url}/v1/models`, { headers: { authorization: 'Bearer secret-key' } })).status).toBe(200);
    expect((await fetch(`${api.url}/health`)).status).toBe(200);
  });

  it('answers the allowed origin’s preflight', async () => {
    const r = await fetch(`${api.url}/v1/chat/completions`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' } });
    expect(r.status).toBe(204);
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
  });
});

describe('settings', () => {
  it('uses the local development services when no WEXARE_* setting is given', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ source: 'dev', publishers: 'any' });
    expect(c.relays.length).toBeGreaterThan(0);
  });

  it('reads the deployed app’s settings, with approved publishers', () => {
    const c = loadConfig({ WEXARE_RELAYS: 'wss://relay.example,ws://127.0.0.1:7777' });
    expect(c.relays).toEqual(['wss://relay.example', 'ws://127.0.0.1:7777']);
    expect(Array.isArray(c.publishers) && c.publishers.length).toBeTruthy();
  });

  it('refuses unencrypted relays on other machines', () => {
    expect(checkConfig({ relays: ['ws://relay.example'], ipfsGateways: [], arweaveGateways: [], publishers: 'any', source: 'env' }).join()).toMatch(/wss/);
  });
});
