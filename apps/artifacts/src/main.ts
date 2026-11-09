/// <reference path="./webtorrent.d.ts" />
// wexare-artifacts: static HTTP mirror for one or more content-addressed
// artifact roots, plus a WebTorrent seeder (WebRTC-capable via node-datachannel)
// for every torrent found in those roots.
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import WebTorrent from 'webtorrent';
import { ArtifactRoot } from '@wexare/storage/node';

const program = new Command()
  .name('wexare-artifacts')
  .description('Static artifact mirror + torrent seeder for modelXare artifact roots')
  .option('--root <name=dir>', 'serve an artifact root (repeatable)', (v: string, p: string[] = []) => [...p, v], [])
  .option('--roots-dir <dir>', 'serve every subdirectory as a root (re-scanned periodically)')
  .option('--port <port>', 'HTTP port', '8790')
  .option('--host <host>', 'bind address', '127.0.0.1')
  .option('--no-seed', 'serve HTTP only, do not seed torrents')
  .parse();
const o = program.opts<{ root: string[]; rootsDir?: string; port: string; host: string; seed: boolean }>();

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const roots = new Map<string, ArtifactRoot>();
async function refreshRoots() {
  for (const spec of o.root) {
    const [name, dir] = spec.split('=');
    if (name && dir && NAME.test(name)) roots.set(name, new ArtifactRoot(resolve(dir)));
  }
  if (o.rootsDir) {
    for (const d of await readdir(resolve(o.rootsDir), { withFileTypes: true }).catch(() => [])) {
      if (d.isDirectory() && NAME.test(d.name) && !roots.has(d.name)) roots.set(d.name, new ArtifactRoot(join(resolve(o.rootsDir), d.name)));
    }
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Cache-Control, If-None-Match, If-Modified-Since',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

async function serveFile(req: IncomingMessage, res: ServerResponse, path: string, type: string) {
  const st = await stat(path).catch(() => null);
  if (!st?.isFile()) return void res.writeHead(404, CORS).end('not found');
  const headers: Record<string, string | number> = {
    ...CORS,
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    // Content-addressed bytes never change.
    'Cache-Control': 'public, max-age=31536000, immutable',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : st.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : st.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, st.size - 1);
    if (start > end) return void res.writeHead(416, { ...CORS, 'Content-Range': `bytes */${st.size}` }).end();
    res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
    if (req.method === 'HEAD') return void res.end();
    return void createReadStream(path, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(path).pipe(res);
}

// ---- seeder ----------------------------------------------------------------
type Seeded = { infoHash: string; root: string; name: string; torrent: any; uploaded: number; byType: Record<string, number> };
const seeded = new Map<string, Seeded>();
const client = o.seed ? new WebTorrent({ dht: false, lsd: false, utp: false, natUpnp: false, natPmp: false } as never) : null;
client?.on('error', (e: Error) => console.error('seeder error:', e.message));

async function refreshSeeds() {
  if (!client) return;
  for (const [rootName, root] of roots) {
    for (const t of await root.listTorrents()) {
      if (seeded.has(t.infoHash)) continue;
      const entry: Seeded = { infoHash: t.infoHash, root: rootName, name: '', torrent: null, uploaded: 0, byType: {} };
      seeded.set(t.infoHash, entry);
      const buf = await readFile(t.torrentPath);
      const torrent = client.add(buf, { path: t.seedDir, skipVerify: false } as never);
      entry.torrent = torrent;
      torrent.on('ready', () => {
        entry.name = torrent.name;
        console.log(`seeding ${torrent.name} (${t.infoHash.slice(0, 12)}…) from root ${rootName}: ${torrent.progress === 1 ? 'complete' : 'INCOMPLETE DATA'}`);
      });
      torrent.on('wire', (wire: any) => {
        wire.on('upload', (n: number) => {
          entry.uploaded += n;
          entry.byType[wire.type] = (entry.byType[wire.type] ?? 0) + n;
        });
      });
      torrent.on('error', (e: Error) => console.error(`torrent ${t.infoHash}: ${e.message}`));
    }
  }
}

// ---- HTTP ------------------------------------------------------------------
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return void res.writeHead(204, { ...CORS, 'Access-Control-Max-Age': '86400' }).end();
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405, CORS).end();
    const url = new URL(req.url ?? '/', 'http://x');
    let m = /^\/([a-z0-9-]+)\/sha256\/([0-9a-f]{64})$/.exec(url.pathname);
    if (m) {
      const root = roots.get(m[1]!);
      if (!root) return void res.writeHead(404, CORS).end('unknown root');
      return serveFile(req, res, root.blobPath(m[2]!), 'application/octet-stream');
    }
    m = /^\/([a-z0-9-]+)\/torrents\/([0-9a-f]{40})\.torrent$/.exec(url.pathname);
    if (m) {
      const root = roots.get(m[1]!);
      if (!root) return void res.writeHead(404, CORS).end('unknown root');
      return serveFile(req, res, join(root.dir, 'torrents', `${m[2]}.torrent`), 'application/x-bittorrent');
    }
    if (url.pathname === '/' || url.pathname === '/status') {
      const body = {
        service: 'wexare-artifacts',
        roots: await Promise.all([...roots].map(async ([name, r]) => ({ name, dir: r.dir, blobs: (await r.list()).length }))),
        seeding: client
          ? [...seeded.values()].map((s) => ({
              infoHash: s.infoHash,
              name: s.name,
              root: s.root,
              ready: !!s.torrent?.ready,
              complete: s.torrent?.progress === 1,
              peers: s.torrent?.numPeers ?? 0,
              uploadedBytes: Math.max(s.uploaded, s.torrent?.uploaded ?? 0),
              uploadedByWireType: s.byType,
            }))
          : 'disabled',
      };
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return void res.end(JSON.stringify(body, null, 2));
    }
    res.writeHead(404, CORS).end('not found');
  } catch (e) {
    res.writeHead(500, CORS).end(String(e));
  }
});

await refreshRoots();
await refreshSeeds();
setInterval(() => void refreshRoots().then(refreshSeeds), 5000).unref();
server.listen(Number(o.port), o.host, () => {
  console.log(`artifacts: http://${o.host}:${o.port}/ roots: ${[...roots.keys()].join(', ') || '(none yet)'}; seeding ${client ? 'on (WebRTC via tracker)' : 'off'}`);
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    client?.destroy(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
