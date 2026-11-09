// The local runtime in one object: releases from relays, verified files, the
// models that can run here, and the two native runtimes. Language models take
// turns on one llama.cpp context (one model loaded at a time, like the
// browser); the router keeps its own. Both are unloaded after a while unused.
import { openAsBlob } from 'node:fs';
import { join } from 'node:path';
import { routerFiles } from '@wexare/router';
import { readGgufHeader } from '@wexare/runtime/gguf';
import type { CandidateRelease } from '@wexare/orchestrator';
import type { ManifestFile } from '@wexare/protocol';
import { buildCatalog, missingBytes, type Catalog, type LocalModel } from './catalog.ts';
import { Trust, type LocalConfig } from './config.ts';
import { FileStore, type Progress } from './files.ts';
import { NativeLaya, type LayaLoadOptions } from './laya.ts';
import { NativeLlama, type ChatRun, type CompleteRun, type LlamaOptions, type Output } from './llama.ts';
import { ReleaseStore, syncReleases, type RelayRead } from './releases.ts';

export interface EngineOptions {
  home: string;
  config: LocalConfig;
  llama: LlamaOptions;
  laya?: LayaLoadOptions;
  /** Download a catalog model the first time a request needs it (otherwise `modelxare pull` first). */
  pullOnDemand?: boolean;
  /** Unload models after this many ms unused; 0 keeps them loaded. */
  idleMs?: number;
  /** The model `auto` answers with when no specialist fits; default: the largest downloaded chat model. */
  general?: string;
  log?: (line: string) => void;
}

/** A request for a model that isn't on this machine yet. */
export class NotDownloadedError extends Error {
  readonly code = 'model_not_downloaded';
  constructor(readonly model: string) {
    super(`${model} isn't downloaded yet: run \`modelxare pull ${model}\` (or start the server with --pull)`);
  }
}

export class Engine {
  readonly files: FileStore;
  readonly releases: ReleaseStore;
  readonly trust: Trust;
  readonly llama: NativeLlama;
  catalog: Catalog = { models: [], router: null, skipped: [] };
  private laya: Promise<NativeLaya> | null = null;
  private turn: Promise<unknown> = Promise.resolve();
  private routerTurn: Promise<unknown> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | null = null;
  private readonly contexts = new Map<string, number | null>();
  private readonly log: (line: string) => void;

  constructor(readonly options: EngineOptions) {
    this.files = new FileStore(join(options.home, 'files'));
    this.releases = new ReleaseStore(join(options.home, 'releases.json'));
    this.trust = new Trust(options.config.publishers);
    this.log = options.log ?? (() => undefined);
    this.llama = new NativeLlama({ ...options.llama, log: this.log });
    this.refresh();
  }

  /** Rebuild what can run from the stored releases and the files on disk. */
  refresh(): Catalog {
    const sizes = new Map<string, number>();
    const releases = this.releases.verified();
    for (const r of releases) for (const f of r.manifest.files) sizes.set(f.sha256, f.size);
    this.catalog = buildCatalog(releases, this.trust, (sha) => this.files.has(sha, sizes.get(sha) ?? -1));
    return this.catalog;
  }

  /** Read the relays for new releases. */
  async sync(timeoutMs?: number): Promise<RelayRead[]> {
    const reads = await syncReleases(this.releases, this.options.config.relays, this.trust.authors(), timeoutMs);
    this.refresh();
    return reads;
  }

  model(id: string): LocalModel | undefined {
    return this.catalog.models.find((m) => m.id === id);
  }

  isReady(files: { sha256: string; size: number }[]): boolean {
    return missingBytes(files, (s, n) => this.files.has(s, n)) === 0;
  }

  /** Models a client may ask for now: downloaded ones, or every one when downloads happen on demand. */
  servable(): LocalModel[] {
    return this.catalog.models.filter((m) => this.options.pullOnDemand || this.isReady(m.files));
  }

  routerFiles(): ManifestFile[] {
    return this.catalog.router?.manifest.files ?? [];
  }

  /** Download (and verify) every missing file. */
  async pull(files: ManifestFile[], onProgress?: Progress, signal?: AbortSignal): Promise<void> {
    const gateways = { ipfs: this.options.config.ipfsGateways, arweave: this.options.config.arweaveGateways };
    for (const f of files) if (!this.files.has(f.sha256, f.size)) await this.files.download(f, gateways, onProgress, signal);
  }

  private async ready(name: string, files: ManifestFile[], signal?: AbortSignal): Promise<void> {
    if (this.isReady(files)) return;
    if (!this.options.pullOnDemand) throw new NotDownloadedError(name);
    this.log(`downloading ${name} (${files.length} file${files.length === 1 ? '' : 's'})`);
    await this.pull(files, undefined, signal);
    this.refresh();
  }

  /** Language-model work takes turns: one model is loaded and used at a time. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.turn.then(() => {
      this.wake();
      return fn();
    });
    this.turn = run.then(
      () => this.rest(),
      () => this.rest(),
    );
    return run;
  }

  private wake(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
  }

  private rest(): void {
    const ms = this.options.idleMs ?? 0;
    if (!ms) return;
    this.wake();
    this.idle = setTimeout(() => void this.sleep(), ms);
    this.idle.unref();
  }

  /** Unload everything (idle, or on request). */
  async sleep(): Promise<void> {
    await this.exclusiveRaw(async () => {
      if (this.llama.loaded) this.log('unloading the language model (idle)');
      await this.llama.unload();
    });
    await this.withRouter(async () => {
      if (this.laya) this.log('unloading the router (idle)');
      const laya = this.laya;
      this.laya = null;
      await (await laya?.catch(() => null))?.close();
    });
  }

  private exclusiveRaw<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.turn.then(fn);
    this.turn = run.catch(() => undefined);
    return run;
  }

  /** The identity a load is known by, the orchestrator's way, so either path reuses the other's load. */
  static keyFor(m: LocalModel): string {
    const runs = m.base ?? m.release;
    return [...runs.manifest.files.map((f) => f.sha256), ...(m.base ? [`lora:${m.release.manifest.files[0]!.sha256}`] : [])].join('+');
  }

  /** Load a model's verified files (inside a turn). */
  private async load(m: LocalModel, signal?: AbortSignal): Promise<void> {
    await this.ready(m.id, m.files, signal);
    const runs = m.base ?? m.release;
    const weights = runs.manifest.files.filter((f) => f.role === 'weights');
    if (weights.length !== 1) throw new Error(`${m.id}: models split into several GGUF files are not supported by the native runtime yet`);
    const adapters = m.base ? m.release.manifest.files.filter((f) => f.role === 'adapter') : [];
    const t0 = Date.now();
    const loading = !this.llama.residentKeys.includes(Engine.keyFor(m));
    await this.llama.ensure({
      key: Engine.keyFor(m),
      weights: await this.files.verify(weights[0]!.sha256, weights[0]!.size),
      adapters: await Promise.all(adapters.map(async (f) => ({ path: await this.files.verify(f.sha256, f.size), sha256: f.sha256, scale: 1 }))),
      chatTemplate: runs.manifest.runtime.chat_template,
    });
    if (loading) this.log(`loaded ${m.id} in ${Date.now() - t0} ms (context ${this.llama.contextSize} tokens)`);
    this.contexts.set(m.id, this.llama.contextSize);
  }

  /** One chat turn. A model without a chat format continues the last message instead. */
  chat(m: LocalModel, run: ChatRun): Promise<Output> {
    return this.exclusive(async () => {
      await this.load(m, run.signal);
      if (m.chat) return this.llama.chat(run);
      const last = [...run.messages].reverse().find((x) => x.role === 'user')?.content ?? '';
      return this.llama.complete({ ...run, prompt: last });
    });
  }

  complete(m: LocalModel, run: CompleteRun): Promise<Output> {
    return this.exclusive(async () => {
      await this.load(m, run.signal);
      return this.llama.complete(run);
    });
  }

  /** Tokens of context a model gets here: what it was loaded with, or its trained size within the limit. */
  async contextLength(m: LocalModel): Promise<number | null> {
    const known = this.contexts.get(m.id);
    if (known) return known;
    const runs = m.base ?? m.release;
    const w = runs.manifest.files.find((f) => f.role === 'weights');
    if (!w || !this.files.has(w.sha256, w.size)) return null;
    try {
      const header = await readGgufHeader(await openAsBlob(this.files.path(w.sha256)), 1 << 20);
      const key = Object.keys(header.metadata).find((k) => k.endsWith('.context_length'));
      const trained = key ? Number(header.metadata[key]) : NaN;
      const n = Number.isFinite(trained) && trained > 0 ? Math.min(trained, this.options.llama.contextSize) : this.options.llama.contextSize;
      this.contexts.set(m.id, n);
      return n;
    } catch {
      return null;
    }
  }

  /** The model `auto` falls back to: the one asked for, else the largest downloaded chat model. */
  generalModel(): LocalModel | null {
    const asked = this.options.general;
    if (asked) return this.model(asked) ?? null;
    const size = (m: LocalModel) => m.files.reduce((n, f) => n + f.size, 0);
    return (
      this.catalog.models
        .filter((m) => m.chat && !m.base && (this.options.pullOnDemand || this.isReady(m.files)))
        .sort((a, b) => size(b) - size(a) || a.id.localeCompare(b.id))[0] ?? null
    );
  }

  /** Releases `auto` may hand a step to: models (not adapters) that are here, or may be fetched. */
  specialists(): CandidateRelease[] {
    return this.catalog.models.filter((m) => !m.base && (this.options.pullOnDemand || this.isReady(m.files))).map((m) => m.release);
  }

  /** System 1 work takes turns too. */
  private withRouter<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.routerTurn.then(fn);
    this.routerTurn = run.catch(() => undefined);
    return run;
  }

  /** The System 1 router, loaded once (downloaded first when allowed). */
  router(signal?: AbortSignal): Promise<NativeLaya> {
    const release = this.catalog.router;
    if (!release) return Promise.reject(new Error('no approved System 1 router is published on the relays this runtime reads'));
    if (this.laya) return this.laya;
    this.laya = (async () => {
      await this.ready('the System 1 router', release.manifest.files, signal);
      const f = routerFiles(release.manifest)!;
      const t0 = Date.now();
      const verified = await Promise.all([f.weights, f.tokenizer, f.tokenizerConfig, f.config].map((x) => this.files.verify(x.sha256, x.size)));
      const laya = await NativeLaya.load({ weights: verified[0]!, tokenizer: verified[1]!, tokenizerConfig: verified[2]!, config: verified[3]! }, this.options.laya);
      this.log(`loaded the System 1 router (${release.name}) in ${Date.now() - t0} ms`);
      return laya;
    })();
    this.laya.catch(() => (this.laya = null));
    return this.laya;
  }

  /** One System 1 reading, in turn. */
  decide<T>(fn: (laya: NativeLaya) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.withRouter(async () => {
      this.wake();
      try {
        return await fn(await this.router(signal));
      } finally {
        this.rest();
      }
    });
  }

  async close(): Promise<void> {
    this.wake();
    const laya = this.laya;
    this.laya = null;
    await (await laya?.catch(() => null))?.close();
    await this.llama.close();
  }
}
