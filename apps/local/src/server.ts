// The OpenAI-compatible API over the local runtime: GET /v1/models,
// POST /v1/chat/completions (streaming, tools, JSON output) and
// POST /v1/completions, for any agent or client that speaks the OpenAI API.
//
// Safe by default: it listens on this machine only; listening wider needs an
// API key. Browsers on other sites can't drive it: JSON bodies only (so a
// cross-site request always needs a CORS preflight, which is refused unless
// the origin is allowed), and on loopback only localhost names are accepted
// as Host (no DNS rebinding). Requests and answers are never logged, only
// which model ran and how long it took.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { AUTO_ID, totalBytes, type LocalModel } from './catalog.ts';
import { runAuto, type AutoOutput } from './auto.ts';
import { NotDownloadedError, type Engine } from './engine.ts';
import type { ChatRun, Output } from './llama.ts';
import { ApiError, chatChunk, chatCompletion, newId, parseChatRequest, parseCompletionRequest, sse, textChunk, textCompletion, toolCallsOf, usageChunk, type Defaults } from './openai.ts';

export interface ServerOptions {
  host: string;
  port: number;
  /** Required from clients when set (Authorization: Bearer <key>). */
  apiKey?: string;
  /** Browser origins allowed to call the API (CORS); none by default. */
  corsOrigins?: string[];
  /** Largest request body, in bytes. */
  maxBodyBytes?: number;
  defaults?: Defaults;
  log?: (line: string) => void;
}

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
export const isLoopback = (host: string) => LOOPBACK_HOSTS.includes(host) || /^127\./.test(host);

/** The Host header's name, without the port. */
const hostName = (header: string | undefined) => (header ?? '').replace(/:\d+$/, '').toLowerCase();

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') throw new ApiError(415, 'send the request body as JSON (Content-Type: application/json)');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new ApiError(413, `the request body is larger than ${limit} bytes`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'the request body is not valid JSON');
  }
}

export function createApi(engine: Engine, options: ServerOptions): Server {
  const log = options.log ?? (() => undefined);
  const defaults = options.defaults ?? { maxTokens: 1024 };
  const limit = options.maxBodyBytes ?? 16 * 1024 * 1024;
  const cors = new Set(options.corsOrigins ?? []);
  const checkHost = isLoopback(options.host);

  const send = (res: ServerResponse, status: number, body: unknown) => {
    if (res.headersSent) return void res.end();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const modelFor = (id: string): LocalModel | typeof AUTO_ID => {
    const name = id.replace(/^modelxare\//, '');
    if (name === AUTO_ID) return AUTO_ID;
    const m = engine.model(name);
    if (!m) throw new ApiError(404, `The model \`${name}\` does not exist here; GET /v1/models lists the models this runtime serves.`, 'invalid_request_error', 'model', 'model_not_found');
    if (!engine.options.pullOnDemand && !engine.isReady(m.files)) throw new ApiError(404, new NotDownloadedError(name).message, 'invalid_request_error', 'model', 'model_not_downloaded');
    return m;
  };

  const listModels = async () => {
    const entries = [];
    const general = engine.generalModel();
    const router = engine.catalog.router;
    if (router || general) {
      entries.push({
        id: AUTO_ID,
        object: 'model',
        created: 0,
        owned_by: 'modelxare',
        ...contextFields(general ? await engine.contextLength(general) : null),
        modelxare: {
          name: 'System 1 + System 2',
          description: 'The System 1 router reads each request and hands each task to a specialist model; a general model answers the rest.',
          router: router ? { name: router.name, downloaded: engine.isReady(router.manifest.files) } : null,
          general_model: general?.id ?? null,
        },
      });
    }
    for (const m of engine.servable()) entries.push({ ...modelEntry(m), ...contextFields(await engine.contextLength(m)) });
    return { object: 'list', data: entries };
  };

  const modelEntry = (m: LocalModel) => ({
    id: m.id,
    object: 'model',
    created: m.createdAt,
    owned_by: m.publisher,
    modelxare: {
      name: m.name,
      description: m.description,
      tasks: m.tasks,
      chat: m.chat,
      license: m.license,
      size_bytes: totalBytes(m.files),
      downloaded: engine.isReady(m.files),
      release_id: m.release.eventId,
      ...(m.base ? { base_release_id: m.base.eventId } : {}),
    },
  });

  const contextFields = (n: number | null) => (n ? { context_length: n, max_model_len: n } : {});

  async function chat(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<string> {
    const r = parseChatRequest(await readJson(req, limit), defaults);
    const target = modelFor(r.model);
    const name = target === AUTO_ID ? AUTO_ID : target.id;
    const id = newId('chatcmpl');
    const created = Math.floor(Date.now() / 1000);
    const run: ChatRun = { ...r.run, signal };
    const exec = (): Promise<Output | AutoOutput> => (target === AUTO_ID ? runAuto(engine, run) : engine.chat(target, run));

    if (!r.stream) {
      const out = await exec();
      send(res, 200, chatCompletion(id, name, created, out, 'route' in out ? { modelxare: out.route } : {}));
      return summary(name, out);
    }
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(sse(chatChunk(id, name, created, { role: 'assistant', content: '' })));
    };
    run.onText = (delta) => {
      if (!delta) return;
      start();
      res.write(sse(chatChunk(id, name, created, { content: delta })));
    };
    let out: Output | AutoOutput;
    try {
      out = await exec();
    } catch (e) {
      if (!started || signal.aborted) throw e;
      res.write(sse(errorBody(e)));
      res.end(sse('[DONE]'));
      return `${name} failed mid-stream`;
    }
    start();
    if (out.toolCalls.length) {
      const calls = toolCallsOf(out, out.toolCalls.map(() => newId('call')));
      res.write(sse(chatChunk(id, name, created, { tool_calls: calls.map((c, index) => ({ index, ...c })) })));
    }
    res.write(sse(chatChunk(id, name, created, {}, out.finishReason, 'route' in out ? { modelxare: out.route } : {})));
    if (r.includeUsage) res.write(sse(usageChunk(id, name, created, out)));
    res.end(sse('[DONE]'));
    return summary(name, out);
  }

  async function complete(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<string> {
    const r = parseCompletionRequest(await readJson(req, limit), defaults);
    const target = modelFor(r.model);
    if (target === AUTO_ID) throw new ApiError(400, '`auto` answers chat requests; use /v1/chat/completions, or name a model here', 'invalid_request_error', 'model');
    const id = newId('cmpl');
    const created = Math.floor(Date.now() / 1000);
    if (!r.stream) {
      const out = await engine.complete(target, { ...r.run, signal });
      send(res, 200, textCompletion(id, target.id, created, out));
      return summary(target.id, out);
    }
    let started = false;
    const start = () => {
      if (!started) res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      started = true;
    };
    try {
      const out = await engine.complete(target, {
        ...r.run,
        signal,
        onText: (t) => {
          start();
          res.write(sse(textChunk(id, target.id, created, t)));
        },
      });
      start();
      res.write(sse(textChunk(id, target.id, created, '', out.finishReason)));
      if (r.includeUsage) res.write(sse(usageChunk(id, target.id, created, out, 'text_completion')));
      res.end(sse('[DONE]'));
      return summary(target.id, out);
    } catch (e) {
      if (!started || signal.aborted) throw e;
      res.write(sse(errorBody(e)));
      res.end(sse('[DONE]'));
      return `${target.id} failed mid-stream`;
    }
  }

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const origin = req.headers.origin;
    const ac = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    let note = '';
    try {
      if (checkHost && !isLoopback(hostName(req.headers.host))) throw new ApiError(403, 'this server only answers requests addressed to localhost', 'permission_error');
      if (origin) {
        if (!cors.has(origin)) throw new ApiError(403, `requests from web pages at ${origin} are not allowed (start the server with --cors-origin ${origin} to allow them)`, 'permission_error');
        res.setHeader('access-control-allow-origin', origin);
        res.setHeader('vary', 'origin');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600' });
          return void res.end();
        }
      }
      if (options.apiKey && path !== '/health') {
        const auth = req.headers.authorization ?? '';
        const given = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : String(req.headers['x-api-key'] ?? '');
        if (!sameSecret(given, options.apiKey)) throw new ApiError(401, 'missing or wrong API key (Authorization: Bearer <key>)', 'authentication_error', null, 'invalid_api_key');
      }
      if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok', models: engine.servable().length, router: !!engine.catalog.router });
      if (req.method === 'GET' && path === '/v1/models') return send(res, 200, await listModels());
      if (req.method === 'GET' && path.startsWith('/v1/models/')) {
        const id = decodeURIComponent(path.slice('/v1/models/'.length));
        const list = await listModels();
        const entry = list.data.find((m) => m.id === id);
        if (!entry) throw new ApiError(404, `The model \`${id}\` does not exist here`, 'invalid_request_error', 'model', 'model_not_found');
        return send(res, 200, entry);
      }
      if (path === '/v1/chat/completions' || path === '/v1/completions') {
        if (req.method !== 'POST') throw new ApiError(405, `${path} takes POST`);
        note = path === '/v1/chat/completions' ? await chat(req, res, ac.signal) : await complete(req, res, ac.signal);
        return;
      }
      throw new ApiError(404, `no route ${req.method} ${path}`, 'invalid_request_error', null, 'not_found');
    } catch (e) {
      const err = toApiError(e);
      note = `${err.status} ${err.code ?? err.type}`;
      if (ac.signal.aborted) note = 'client went away';
      else send(res, err.status, err.toJSON());
    } finally {
      if (path.startsWith('/v1/') && req.method !== 'OPTIONS') log(`${req.method} ${path} ${note || res.statusCode} ${Date.now() - t0} ms`);
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  return server;
}

function summary(model: string, out: Output | AutoOutput): string {
  const route = 'route' in out ? ` via ${out.route.answered_by === 'specialists' ? out.route.steps.map((s) => `${s.task}→${s.model}`).join(', ') : `general ${out.route.general_model}`}` : '';
  return `${model}${route}: ${out.finishReason}, ${out.completionTokens} tokens`;
}

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof NotDownloadedError) return new ApiError(404, e.message, 'invalid_request_error', 'model', e.code);
  const message = (e as Error)?.message ?? String(e);
  if ((e as { code?: string })?.code === 'canceled') return new ApiError(499, 'canceled', 'canceled');
  return new ApiError(500, message, 'server_error');
}

const errorBody = (e: unknown) => toApiError(e).toJSON();
