// modelxare: modelXare on your own machine.
//
//   modelxare list                 models from the catalog, and which are downloaded
//   modelxare pull <model…>        download and verify (router: the System 1 router; auto: router + every model)
//   modelxare run <model> [text]   one answer, in the terminal
//   modelxare serve                the OpenAI-compatible API, for agents and apps
//   modelxare rm <model…>          free the space a model takes
import { Command, InvalidArgumentError, Option } from 'commander';
import { totalBytes, type LocalModel } from './catalog.ts';
import { defaultHome, loadConfig, loadEnvFile, type LocalConfig } from './config.ts';
import { runAuto } from './auto.ts';
import { Engine } from './engine.ts';
import type { ManifestFile } from '@wexare/protocol';
import { createApi, isLoopback } from './server.ts';

const env = process.env;

const size = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

const int = (name: string) => (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError(`${name} must be a whole number`);
  return n;
};

const program = new Command('modelxare')
  .description('modelXare on your own machine: catalog models run natively, behind an OpenAI-compatible API.')
  .option('--home <dir>', 'where models and releases are kept (WEXARE_LOCAL_HOME)')
  .option('--env <file>', 'read WEXARE_* settings from this file first (e.g. infra/deploy/app.env)')
  .showHelpAfterError();

interface RuntimeFlags {
  ctxSize: number;
  keepLoaded?: number;
  gpu: string;
  threads?: number;
  pull?: boolean;
  idle?: number;
  general?: string;
}

const runtimeOptions = (cmd: Command) =>
  cmd
    .option('--ctx-size <tokens>', 'most tokens of context per model (its trained size when smaller)', int('--ctx-size'), Number(env.WEXARE_LOCAL_CONTEXT ?? 32768))
    .addOption(new Option('--gpu <backend>', 'llama.cpp backend').choices(['auto', 'off', 'metal', 'cuda', 'vulkan']).default(env.WEXARE_LOCAL_GPU ?? 'auto'))
    .option('--threads <n>', 'CPU threads (default: llama.cpp chooses)', int('--threads'))
    .option('--keep-loaded <n>', 'language models kept loaded at once', int('--keep-loaded'), Number(env.WEXARE_LOCAL_KEEP_LOADED ?? 3))
    .option('--general <model>', 'the model `auto` answers with when no specialist fits (default: the largest downloaded chat model)');

function open(flags: Partial<RuntimeFlags> = {}): { engine: Engine; config: LocalConfig } {
  const global = program.opts<{ home?: string; env?: string }>();
  if (global.env) loadEnvFile(global.env);
  const config = loadConfig();
  const engine = new Engine({
    home: global.home ?? defaultHome(),
    config,
    llama: { gpu: flags.gpu === 'off' ? false : ((flags.gpu ?? 'auto') as 'auto'), contextSize: flags.ctxSize ?? 32768, maxLoaded: flags.keepLoaded ?? 3, ...(flags.threads ? { threads: flags.threads } : {}) },
    pullOnDemand: !!flags.pull,
    idleMs: (flags.idle ?? 0) * 60_000,
    ...(flags.general ? { general: flags.general } : {}),
    log: (line) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
  });
  return { engine, config };
}

/** Read the relays (unless offline), saying where from and what came back. */
async function sync(engine: Engine, config: LocalConfig, offline?: boolean): Promise<void> {
  if (offline) return;
  if (config.source === 'dev') console.error('No WEXARE_RELAYS set: reading the local development relays. For the public catalog, see docs/local.md.');
  const reads = await engine.sync();
  for (const r of reads) {
    if (r.error && !r.received) console.error(`  ✗ ${r.relay}: ${r.error}`);
  }
  if (reads.every((r) => r.error && !r.received)) console.error('No relay answered; using the releases saved on this machine.');
}

function resolve(engine: Engine, names: string[], all?: boolean): { label: string; files: ManifestFile[] }[] {
  const out: { label: string; files: ManifestFile[] }[] = [];
  const add = (label: string, files: ManifestFile[]) => out.push({ label, files });
  const router = () => {
    const r = engine.catalog.router;
    if (!r) throw new Error('no approved System 1 router is published on these relays');
    add(`router (${r.name})`, r.manifest.files);
  };
  if (all || names.includes('auto')) {
    router();
    for (const m of engine.catalog.models) add(m.id, m.files);
    return out;
  }
  for (const n of names) {
    if (n === 'router') router();
    else {
      const m = engine.model(n);
      if (!m) throw new Error(`no model \`${n}\` in the catalog (\`modelxare list\` shows them)`);
      add(m.id, m.files);
    }
  }
  return out;
}

program
  .command('list')
  .alias('ls')
  .description('the models this machine can run, and which are downloaded')
  .option('--offline', "don't read the relays; list the releases saved here")
  .option('--all', 'also list releases this runtime can’t run, and why')
  .action(async (o: { offline?: boolean; all?: boolean }) => {
    const { engine, config } = open();
    await sync(engine, config, o.offline);
    const { models, router, skipped } = engine.catalog;
    if (!models.length && !router) {
      console.log('No models yet: no approved releases on these relays.');
      return;
    }
    const rows = models.map((m) => [m.id, engine.isReady(m.files) ? 'downloaded' : `${size(totalBytes(m.files))} to download`, m.tasks.length ? m.tasks.join(', ') : 'chat', m.chat ? '' : 'continues text', m.publisher]);
    if (router) rows.unshift(['router', engine.isReady(router.manifest.files) ? 'downloaded' : `${size(totalBytes(router.manifest.files))} to download`, 'System 1: decides which model does what', '', '']);
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd());
    console.log(`\n\`auto\` (System 1 + System 2): ${router && engine.isReady(router.manifest.files) ? 'ready' : 'needs the router: modelxare pull router'}`);
    if (o.all) for (const s of skipped) console.log(`can't run ${s.name}: ${s.reasons.join('; ')}`);
  });

program
  .command('pull')
  .description('download and verify models (`router` for System 1, `auto` for the router and every model)')
  .argument('[models...]')
  .option('--all', 'every model and the router')
  .option('--offline', "don't read the relays first")
  .action(async (names: string[], o: { all?: boolean; offline?: boolean }) => {
    if (!names.length && !o.all) throw new Error('name the models to pull (see `modelxare list`), or --all');
    const { engine, config } = open();
    await sync(engine, config, o.offline);
    for (const { label, files } of resolve(engine, names, o.all)) {
      const total = totalBytes(files);
      if (engine.isReady(files)) {
        console.log(`✓ ${label} already downloaded`);
        continue;
      }
      const done = new Map<string, number>();
      let last = 0;
      await engine.pull(files, (sha, bytes) => {
        done.set(sha, bytes);
        const now = Date.now();
        if (now - last < 250 || !process.stderr.isTTY) return;
        last = now;
        const got = files.reduce((n, f) => n + (engine.files.has(f.sha256, f.size) ? f.size : (done.get(f.sha256) ?? 0)), 0);
        process.stderr.write(`\r  ${label}: ${size(got)} of ${size(total)} (${Math.floor((got / total) * 100)}%)   `);
      });
      if (process.stderr.isTTY) process.stderr.write('\r\x1b[K');
      console.log(`✓ ${label}: ${size(total)}, every file checked against its SHA-256`);
    }
  });

program
  .command('rm')
  .description("delete a model's files from this machine (files another downloaded model uses stay)")
  .argument('<models...>')
  .action(async (names: string[]) => {
    const { engine } = open();
    const targets = resolve(engine, names);
    const removing = new Set(targets.flatMap((t) => t.files.map((f) => f.sha256)));
    const keep = new Set(
      [...engine.catalog.models.filter((m) => !names.includes(m.id) && engine.isReady(m.files)).flatMap((m) => m.files), ...(names.includes('router') ? [] : engine.routerFiles())].map((f) => f.sha256),
    );
    let freed = 0;
    for (const t of targets) for (const f of t.files) if (removing.has(f.sha256) && !keep.has(f.sha256) && engine.files.has(f.sha256, f.size)) {
      engine.files.remove(f.sha256);
      freed += f.size;
    }
    console.log(`Freed ${size(freed)}.`);
  });

runtimeOptions(
  program
    .command('run')
    .description('one answer in the terminal (text from the arguments, or from stdin)')
    .argument('<model>', 'a model id, or auto')
    .argument('[text...]')
    .option('--system <text>', 'a system message')
    .option('--max-tokens <n>', 'longest answer', int('--max-tokens'), 512)
    .option('--temperature <t>', 'sampling temperature', Number, 0.7)
    .option('--pull', 'download the models it needs first')
    .option('--offline', "don't read the relays first"),
).action(async (id: string, words: string[], o: RuntimeFlags & { system?: string; maxTokens: number; temperature: number; offline?: boolean }) => {
  let text = words.join(' ');
  if (!text && !process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    text = Buffer.concat(chunks).toString('utf8');
  }
  if (!text.trim()) throw new Error('give the text to answer, as arguments or on stdin');
  const { engine, config } = open(o);
  try {
    await sync(engine, config, o.offline);
    const run = {
      messages: [...(o.system ? [{ role: 'system' as const, content: o.system }] : []), { role: 'user' as const, content: text }],
      maxTokens: o.maxTokens,
      temperature: o.temperature,
      onText: (t: string) => process.stdout.write(t),
    };
    if (id === 'auto') {
      const out = await runAuto(engine, run);
      process.stdout.write('\n');
      const r = out.route;
      if (r.system1) console.error(`System 1 (${r.system1.router}, ${r.system1.latency_ms} ms): ${r.system1.readings.map((x) => `"${x.text}" → ${x.choice} ${x.probability.toFixed(2)}`).join('; ')}`);
      console.error(r.answered_by === 'specialists' ? `System 2: ${r.steps.map((s) => `${s.task} by ${s.model} (${s.ms} ms)`).join(', ')}` : `Answered by ${r.general_model}: ${r.reason}`);
    } else {
      const m: LocalModel | undefined = engine.model(id);
      if (!m) throw new Error(`no model \`${id}\` (\`modelxare list\` shows them)`);
      const out = await engine.chat(m, run);
      process.stdout.write('\n');
      console.error(`${m.id}: ${out.completionTokens} tokens in ${out.ms} ms (${await engine.llama.backend()})`);
    }
  } finally {
    await engine.close();
  }
});

runtimeOptions(
  program
    .command('serve')
    .description('the OpenAI-compatible API (http://127.0.0.1:8796/v1 by default)')
    .option('--host <address>', 'address to listen on; anything but this machine needs --api-key', env.WEXARE_LOCAL_HOST ?? '127.0.0.1')
    .option('--port <port>', 'port', int('--port'), Number(env.WEXARE_LOCAL_PORT ?? 8796))
    .option('--api-key <key>', 'require this key from clients (WEXARE_LOCAL_API_KEY)')
    .option('--cors-origin <origin...>', 'web page origins allowed to call the API')
    .option('--pull', 'download catalog models the first time a request needs them')
    .option('--idle <minutes>', 'unload models after this many minutes unused (0: never)', int('--idle'), 15)
    .option('--max-tokens <n>', 'longest answer when a request does not say', int('--max-tokens'), 1024)
    .option('--offline', "don't read the relays"),
).action(async (o: RuntimeFlags & { host: string; port: number; apiKey?: string; corsOrigin?: string[]; maxTokens: number; offline?: boolean }) => {
  const apiKey = o.apiKey ?? env.WEXARE_LOCAL_API_KEY?.trim();
  if (!isLoopback(o.host) && !apiKey) throw new Error(`listening on ${o.host} lets other machines use your models: set --api-key (or WEXARE_LOCAL_API_KEY) too`);
  const { engine, config } = open(o);
  await sync(engine, config, o.offline);
  const log = (line: string) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  const server = createApi(engine, { host: o.host, port: o.port, ...(apiKey ? { apiKey } : {}), ...(o.corsOrigin ? { corsOrigins: o.corsOrigin } : {}), defaults: { maxTokens: o.maxTokens }, log });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, o.host, resolve);
  });
  const host = o.host.includes(':') ? `[${o.host}]` : o.host;
  const servable = engine.servable().map((m) => m.id);
  const router = engine.catalog.router;
  console.log(`modelXare is serving the OpenAI API at http://${host}:${o.port}/v1${apiKey ? ' (API key required)' : ''}`);
  console.log(`  models: ${['auto', ...servable].join(', ')}`);
  console.log(`  auto: System 1 ${router && (o.pull || engine.isReady(router.manifest.files)) ? 'ready' : 'not downloaded (modelxare pull router); auto answers with the general model'}, general model ${engine.generalModel()?.id ?? 'none'}`);
  console.log(`  llama.cpp: ${await engine.llama.backend()}; models load on first use${o.idle ? ` and unload after ${o.idle} min unused` : ''}`);
  if (!servable.length) console.log('  No model is downloaded yet: `modelxare pull <model>`, or restart with --pull.');
  const resync = o.offline ? null : setInterval(() => void engine.sync().catch(() => undefined), 15 * 60_000);
  resync?.unref();
  const stop = async () => {
    if (resync) clearInterval(resync);
    server.close();
    server.closeAllConnections();
    await engine.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
});

program.parseAsync().catch((e: Error) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
