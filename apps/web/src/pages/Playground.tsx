import { useEffect, useMemo, useRef, useState } from 'react';
import { MESSAGE_CATEGORIES } from '@wexare/protocol';
import {
  executeWorkflow,
  planWorkflow,
  resolveLoraDependency,
  runSingle,
  type CandidateRelease,
  type StageId,
  type StageTrace,
  type WorkflowResult,
} from '@wexare/orchestrator';
import samples from '../../../../fixtures/messages.json';
import { useApp, useChanges } from '../lib/app.tsx';
import { choiceGrammar, runtime, toCandidate } from '../lib/runtime.ts';
import { formatBytes, ms, shortId } from '../lib/format.ts';
import type { DownloadFile } from '../lib/artifacts.ts';
import { Badge, Fingerprint, Progress, Section } from '../components/common.tsx';

export function Playground() {
  const { catalog, artifacts, catalogVersion, settings, playgroundPreset, setPlaygroundPreset } = useApp();
  useChanges(artifacts);
  const [candidates, setCandidates] = useState<CandidateRelease[]>([]);
  const [input, setInput] = useState(samples.messages[0]!.text);
  const [language, setLanguage] = useState('auto');
  const [explicit, setExplicit] = useState<Partial<Record<StageId, string>>>({});
  const [running, setRunning] = useState(false);
  const [trace, setTrace] = useState<StageTrace[]>([]);
  const [streams, setStreams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<WorkflowResult | null>(null);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void catalog.candidates().then((rows) => setCandidates(rows.map(toCandidate)));
  }, [catalog, catalogVersion]);
  useEffect(() => {
    if (playgroundPreset?.explicit) setExplicit(playgroundPreset.explicit as Partial<Record<StageId, string>>);
  }, [playgroundPreset]);

  const pendingKey = [...artifacts.downloads.values()]
    .filter((d) => d.status === 'queued' || d.status === 'downloading')
    .map((d) => d.sha256)
    .join();
  const plan = useMemo(
    () =>
      planWorkflow(
        input,
        candidates,
        { explicit, preferredPublishers: settings.preferredPublishers, ...(language !== 'auto' ? { language } : {}) },
        artifacts.isCached,
        artifacts.isPending,
      ),
    [input, candidates, explicit, language, settings.preferredPublishers, artifacts, artifacts.cached.size, pendingKey],
  );
  const downloads: DownloadFile[] = plan.downloads.map((d) => {
    const c = candidates.find((x) => x.eventId === d.eventId)!;
    const f = c.manifest.files.find((x) => x.sha256 === d.sha256)!;
    return { sha256: f.sha256, size: f.size, path: f.path, locations: f.locations };
  });
  const downloading = downloads.some((f) => ['queued', 'downloading'].includes(artifacts.downloads.get(f.sha256)?.status ?? ''));
  const failedDownloads = downloads.filter((f) => artifacts.downloads.get(f.sha256)?.status === 'failed');

  const approve = async () => {
    setError('');
    const room = await artifacts.hasRoomFor(plan.downloadBytes);
    if (!room.ok) return setError(`Not enough browser storage: need ${formatBytes(plan.downloadBytes)}, ${formatBytes(room.available)} available.`);
    await artifacts.download(downloads).catch((e) => setError((e as Error).message));
  };

  const run = async () => {
    setError('');
    setResult(null);
    setStreams({});
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const r = await executeWorkflow(
        plan,
        {
          runtime,
          getVerifiedFile: (sha, size) => artifacts.getVerifiedFile(sha, size),
          choiceGrammar,
          onUpdate: setTrace,
          onToken: (stage, text) => setStreams((s) => ({ ...s, [stage]: text })),
        },
        ac.signal,
      );
      setResult(r);
      setTrace(r.trace);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const compatibleFor = (stage: StageId) => plan.stages.find((s) => s.stage === stage)!.considered;

  return (
    <div className="playground">
      <Section title="Message">
        <div className="samples">
          {samples.messages.map((m) => (
            <button key={m.id} className="chip-btn" onClick={() => setInput(m.text)} data-testid={`sample-${m.id}`}>
              {m.id}
            </button>
          ))}
        </div>
        <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={4} data-testid="input" aria-label="Message" />
        <label className="inline">
          Language{' '}
          <select value={language} onChange={(e) => setLanguage(e.target.value)} data-testid="language">
            <option value="auto">auto-detect ({plan.languageSource === 'detected' ? plan.language : '—'})</option>
            <option value="en">English</option>
            <option value="es">Spanish</option>
          </select>
        </label>
        <p className="hint">Prompts and outputs never leave this device. Categories: {MESSAGE_CATEGORIES.join(', ')}.</p>
      </Section>

      <Section title="Plan: community-message triage (classification → summarization)">
        <ol className="plan" data-testid="plan">
          {plan.stages.map((s) => (
            <li key={s.stage} data-testid={`plan-${s.stage}`} data-release={s.release?.eventId ?? ''}>
              <div className="stage-head">
                <strong>{s.stage}</strong>
                {s.release ? (
                  <span>
                    → {s.release.name} <Fingerprint pubkey={s.release.pubkey} /> <span className="mono small">{shortId(s.release.eventId, 16)}</span>
                  </span>
                ) : (
                  <span className="error">missing</span>
                )}
              </div>
              <div className="small">{s.reason}</div>
              <label className="small">
                Choose release{' '}
                <select
                  value={explicit[s.stage] ?? ''}
                  onChange={(e) => setExplicit((x) => ({ ...x, [s.stage]: e.target.value || undefined }))}
                  data-testid={`choose-${s.stage}`}
                >
                  <option value="">automatic</option>
                  {compatibleFor(s.stage).map((c) => (
                    <option key={c.eventId} value={c.eventId} disabled={!c.compatible}>
                      {c.name} ({shortId(c.eventId, 8)}){c.compatible ? '' : ` — ${c.why}`}
                    </option>
                  ))}
                </select>
              </label>
            </li>
          ))}
        </ol>
        {plan.problems.length > 0 && (
          <div className="warn-box" data-testid="plan-problems">
            {plan.problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </div>
        )}
        {downloads.length > 0 && (
          <div className="downloads" data-testid="download-approval">
            <p>
              This plan needs <strong>{formatBytes(plan.downloadBytes)}</strong> of verified model files:
            </p>
            <ul>
              {downloads.map((f) => {
                const st = artifacts.downloads.get(f.sha256);
                return (
                  <li key={f.sha256}>
                    <code>{f.path}</code> {formatBytes(f.size)} <span className="mono small">{shortId(f.sha256, 12)}</span>{' '}
                    {st && <Badge tone={st.status === 'failed' ? 'bad' : 'info'}>{st.status}</Badge>}
                    {st?.status === 'downloading' && <Progress value={st.bytes} max={st.size} />}
                    {st?.error && <span className="small error"> {st.error}</span>}
                  </li>
                );
              })}
            </ul>
            <button className="primary" onClick={approve} disabled={downloading || !settings.networkSync} data-testid="approve-download">
              {failedDownloads.length ? 'Retry downloads' : 'Approve download'}
            </button>
            {downloading && <button onClick={() => artifacts.cancelAll()}>Cancel downloads</button>}
            {!settings.networkSync && <span className="hint"> Network sync is off.</span>}
          </div>
        )}
        <div className="actions">
          <button className="primary" onClick={run} disabled={!plan.ok || downloads.length > 0 || running} data-testid="run-workflow">
            Run locally
          </button>
          {running && (
            <button onClick={() => abortRef.current?.abort()} data-testid="cancel-run">
              Cancel
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </Section>

      {(trace.length > 0 || result) && (
        <Section title="Result">
          {result && (
            <div className={`result-card ${result.status}`} data-testid="result" data-status={result.status}>
              <div>
                <span className="label">Category</span> <strong data-testid="result-category">{result.composed?.category ?? '—'}</strong>
              </div>
              <div>
                <span className="label">Summary</span> <span data-testid="result-summary">{result.composed?.summary ?? '—'}</span>
              </div>
              <div className="small">
                status {result.status} · {ms(result.finishedAt - result.startedAt)} · language {result.language}
              </div>
            </div>
          )}
          <div className="stages">
            {(result?.trace ?? trace).map((t) => (
              <div key={t.stage} className="stage" data-testid={`stage-${t.stage}`} data-state={t.state}>
                <Badge tone={t.state === 'completed' ? 'ok' : t.state === 'failed' ? 'bad' : t.state === 'canceled' ? 'warn' : 'info'}>{t.state}</Badge> <strong>{t.stage}</strong>{' '}
                <span className="small">{t.name}</span>
                {streams[t.stage] && t.state === 'generating' && <pre className="stream">{streams[t.stage]}</pre>}
              </div>
            ))}
          </div>
          <details data-testid="trace">
            <summary>Execution trace</summary>
            {(result?.trace ?? trace).map((t) => (
              <div key={t.stage} className="trace">
                <h3>{t.stage}</h3>
                <dl>
                  <dt>Release ID</dt>
                  <dd className="mono small" data-testid={`trace-release-${t.stage}`}>
                    {t.releaseId}
                  </dd>
                  <dt>Publisher</dt>
                  <dd>
                    <Fingerprint pubkey={t.publisher} />
                  </dd>
                  <dt>Model</dt>
                  <dd>
                    {t.name} ({t.modelId}) · manifest <span className="mono small">{shortId(t.manifestSha256, 16)}</span>
                  </dd>
                  <dt>Files</dt>
                  <dd>
                    {t.files.map((f) => (
                      <div key={f.sha256} className="mono small" data-testid="trace-file">
                        {f.path} {f.sha256}
                      </div>
                    ))}
                  </dd>
                  <dt>Adapters</dt>
                  <dd>{t.adapters.length ? t.adapters.map((a) => `${a.sha256.slice(0, 16)}… × ${a.scale}`).join(', ') : 'none'}</dd>
                  <dt>Timings</dt>
                  <dd>
                    verify {ms(t.verifyMs)} · load {t.reusedLoadedModel ? 'reused resident model' : ms(t.loadMs)} · generate {t.attempts.map((a) => ms(a.ms)).join(' + ') || '—'}
                  </dd>
                  <dt>Attempts</dt>
                  <dd>
                    {t.attempts.map((a, i) => (
                      <div key={i}>
                        <pre className="raw" data-testid={`trace-raw-${t.stage}`}>
                          {a.raw}
                        </pre>
                        {a.error ? <span className="error small">contract check failed: {a.error}</span> : <span className="small">valid: {JSON.stringify(a.parsed)}</span>}
                      </div>
                    ))}
                  </dd>
                  {t.error && (
                    <>
                      <dt>Error</dt>
                      <dd className="error">{t.error}</dd>
                    </>
                  )}
                </dl>
              </div>
            ))}
          </details>
        </Section>
      )}

      <SingleModel candidates={candidates} preset={playgroundPreset?.single} onUsed={() => setPlaygroundPreset(null)} />
    </div>
  );
}

/** One-model debug mode, including LoRA application with/without the adapter. */
function SingleModel({ candidates, preset, onUsed }: { candidates: CandidateRelease[]; preset?: string | undefined; onUsed: () => void }) {
  const { artifacts } = useApp();
  const [id, setId] = useState('');
  const [op, setOp] = useState('');
  const [input, setInput] = useState('Look in thy glass');
  const [scale, setScale] = useState(1);
  const [out, setOut] = useState<StageTrace | null>(null);
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  useEffect(() => {
    if (preset) {
      setId(preset);
      onUsed();
    }
  }, [preset, onUsed]);
  const runnable = candidates.filter((c) => c.support.supported || c.manifest.kind === 'lora');
  const c = candidates.find((x) => x.eventId === id);
  const dep = c?.manifest.kind === 'lora' ? resolveLoraDependency(c, (e) => candidates.find((x) => x.eventId === e) ?? null, artifacts.isCached) : null;
  const ops = c?.support.executableOperations ?? [];
  const opId = ops.includes(op) ? op : ops[0] ?? '';
  const missing = c ? (dep ? dep.files.filter((f) => !f.cached) : c.manifest.files.filter((f) => !artifacts.isCached(f.sha256))) : [];
  const blocked = !!dep && !dep.ok;

  const go = async () => {
    if (!c) return;
    setBusy(true);
    setOut(null);
    setStream('');
    const deps = { runtime, getVerifiedFile: (s: string, n: number) => artifacts.getVerifiedFile(s, n), choiceGrammar, onToken: (_: StageId, t: string) => setStream(t) };
    const t =
      c.manifest.kind === 'lora' && dep?.base
        ? await runSingle(c, opId, input, deps, { adapters: [{ candidate: c, scale }], base: dep.base })
        : await runSingle(c, opId, input, deps);
    setOut({ ...t, adapters: c.manifest.kind === 'lora' ? [{ sha256: c.manifest.files[0]!.sha256, scale }] : [] });
    setBusy(false);
  };

  return (
    <Section title="One-model mode (debugging)">
      <div className="row2">
        <label>
          Release
          <select value={id} onChange={(e) => setId(e.target.value)} data-testid="single-release">
            <option value="">choose…</option>
            {runnable.map((x) => (
              <option key={x.eventId} value={x.eventId}>
                {x.name} ({shortId(x.eventId, 8)}){x.manifest.kind === 'lora' ? ' — LoRA' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Operation
          <select value={opId} onChange={(e) => setOp(e.target.value)}>
            {ops.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        {c?.manifest.kind === 'lora' && (
          <label>
            Adapter scale
            <select value={scale} onChange={(e) => setScale(Number(e.target.value))} data-testid="adapter-scale">
              <option value={1}>1.0 (adapter applied)</option>
              <option value={0}>0.0 (base only)</option>
            </select>
          </label>
        )}
      </div>
      <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} data-testid="single-input" aria-label="Single-model input" />
      {blocked && <div className="warn-box">Blocked: {dep!.problems.join('; ')}</div>}
      {missing.length > 0 && !blocked && (
        <p className="hint">
          Needs {formatBytes(missing.reduce((n, f) => n + f.size, 0))} of files first.{' '}
          <button onClick={() => artifacts.download(missing.map((f) => ({ sha256: f.sha256, size: f.size, path: f.path, locations: candidates.flatMap((x) => x.manifest.files).find((y) => y.sha256 === f.sha256)?.locations ?? [] })))}>
            Download
          </button>
        </p>
      )}
      <button className="primary" disabled={!c || !opId || busy || missing.length > 0 || blocked} onClick={go} data-testid="single-run">
        Run one model
      </button>
      {busy && stream && <pre className="stream">{stream}</pre>}
      {out && (
        <div className="trace" data-testid="single-output" data-state={out.state}>
          <Badge tone={out.state === 'completed' ? 'ok' : 'bad'}>{out.state}</Badge>
          <pre className="raw" data-testid="single-text">
            {out.attempts.at(-1)?.raw ?? ''}
          </pre>
          <div className="small">
            load {out.reusedLoadedModel ? 'reused' : ms(out.loadMs)} · generate {ms(out.attempts.at(-1)?.ms)}
            {runtime.loaded?.adapters.length ? ` · active adapter ${runtime.loaded.adapters[0]!.sha256.slice(0, 12)}… scale ${scale}` : ''}
          </div>
          {runtime.loaded?.adapterEvidence.length ? (
            <details>
              <summary>Runtime adapter evidence (native log)</summary>
              <pre className="raw" data-testid="adapter-evidence">
                {runtime.loaded.adapterEvidence.join('\n')}
              </pre>
            </details>
          ) : null}
          {out.error && <p className="error">{out.error}</p>}
        </div>
      )}
    </Section>
  );
}
