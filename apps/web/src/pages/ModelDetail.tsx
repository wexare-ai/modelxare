import { useEffect, useMemo, useState } from 'react';
import type { ReleaseDetail } from '@wexare/catalog';
import { resolveLoraDependency, type CandidateRelease, type DependencyCheck } from '@wexare/orchestrator';
import { checkReleaseSupport } from '@wexare/runtime/support';
import { useApp, useChanges } from '../lib/app.tsx';
import { capabilities, toCandidate } from '../lib/runtime.ts';
import { formatBytes, npub, when } from '../lib/format.ts';
import type { DownloadFile } from '../lib/artifacts.ts';
import { Badge, Fingerprint, Progress, Section } from '../components/common.tsx';

export function ModelDetail({ id }: { id: string }) {
  const { catalog, artifacts, catalogVersion, go, setPlaygroundPreset, settings } = useApp();
  useChanges(artifacts);
  const [d, setD] = useState<ReleaseDetail | null | undefined>(undefined);
  const [all, setAll] = useState<CandidateRelease[]>([]);
  const [msg, setMsg] = useState('');
  const [conflict, setConflict] = useState<string[] | null>(null);

  useEffect(() => {
    void catalog.getRelease(id).then(setD);
    void catalog.candidates().then((rows) => setAll(rows.map(toCandidate)));
    void catalog.conflicts().then((c) => setConflict(c.find((x) => x.eventIds.includes(id))?.eventIds ?? null));
  }, [catalog, id, catalogVersion]);

  const support = useMemo(() => (d ? checkReleaseSupport(d.manifest, capabilities) : null), [d]);
  const dep: DependencyCheck | null = useMemo(() => {
    if (!d || d.manifest.kind !== 'lora') return null;
    const self = toCandidate({ eventId: d.eventId, pubkey: d.event.pubkey, manifestJson: d.manifestJson, manifestSha256: d.manifestSha256 });
    return resolveLoraDependency(self, (eid) => all.find((c) => c.eventId === eid) ?? null, artifacts.isCached);
  }, [d, all, artifacts, artifacts.cached.size]);

  if (d === undefined) return <p>Loading…</p>;
  if (d === null) return <p>Release {id} is not in the local catalog. <a onClick={() => go({ page: 'discover' })}>Back to Discover</a></p>;
  const m = d.manifest;
  const files: DownloadFile[] = m.files.map((f) => ({ sha256: f.sha256, size: f.size, path: f.path, locations: f.locations }));
  if (dep?.base) for (const f of dep.base.manifest.files) if (!files.some((x) => x.sha256 === f.sha256)) files.push({ sha256: f.sha256, size: f.size, path: `${f.path} (base)`, locations: f.locations });
  const missing = files.filter((f) => !artifacts.isCached(f.sha256));
  const missingBytes = missing.reduce((n, f) => n + f.size, 0);
  const ownCached = m.files.filter((f) => artifacts.isCached(f.sha256)).length;
  const synthetic = !!m.labels?.includes('synthetic');
  const blocked = dep && !dep.ok;
  const downloading = files.some((f) => ['queued', 'downloading'].includes(artifacts.downloads.get(f.sha256)?.status ?? ''));

  const download = async () => {
    setMsg('');
    const room = await artifacts.hasRoomFor(missingBytes);
    if (!room.ok) return setMsg(`Not enough browser storage: need ${formatBytes(missingBytes)}, ${formatBytes(room.available)} available.`);
    try {
      await artifacts.download(missing);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const run = () => {
    if (m.kind === 'lora' || !m.capabilities.some((c) => c === 'text-classification' || c === 'summarization')) setPlaygroundPreset({ single: d.eventId });
    else setPlaygroundPreset({ explicit: Object.fromEntries(m.capabilities.filter((c) => c === 'text-classification' || c === 'summarization').map((c) => [c, d.eventId])) });
    go({ page: 'playground' });
  };

  return (
    <div className="detail" data-testid="model-detail">
      <a className="back" onClick={() => history.back()}>
        ← Back
      </a>
      <h1>
        {m.name} <span className="ver">v{m.version}</span> {m.kind === 'lora' && <span className="kind">LoRA</span>}
      </h1>
      <p className="desc">{m.description}</p>
      <div className="badges">
        <Badge tone="ok" title="Event ID, Schnorr signature, inline manifest hash, schema and tags verified locally">
          metadata verified
        </Badge>
        {synthetic ? <Badge tone="warn">synthetic record · not runnable</Badge> : <Badge tone={ownCached === m.files.length ? 'ok' : 'muted'}>files {ownCached}/{m.files.length} verified locally</Badge>}
        <Badge tone={support?.supported && !blocked ? 'ok' : 'bad'} title={[...(support?.reasons ?? []), ...(dep?.problems ?? [])].join('\n')}>
          {support?.supported && !blocked ? 'runtime supported' : m.kind === 'lora' && !capabilities.adapterExecution.supported ? 'Adapter execution unavailable in this runtime' : 'runtime unsupported'}
        </Badge>
        <Badge tone="muted">quality not evaluated</Badge>
      </div>
      {conflict && (
        <p className="warn-box">
          Conflict: this publisher signed {conflict.length} different manifests for {m.model_id} v{m.version}. They are shown separately and never merged.
        </p>
      )}

      <div className="detail-grid">
        <Section title="Identity">
          <dl>
            <dt>Publisher</dt>
            <dd>
              <Fingerprint pubkey={d.event.pubkey} />
              <div className="mono small">{npub(d.event.pubkey)}</div>
            </dd>
            <dt>Release ID (event)</dt>
            <dd className="mono small" data-testid="release-id">
              {d.eventId}
            </dd>
            <dt>Model family</dt>
            <dd>
              <code>{m.model_id}</code> (publisher key + model ID)
            </dd>
            <dt>Manifest SHA-256</dt>
            <dd className="mono small">{d.manifestSha256}</dd>
            <dt>Published</dt>
            <dd>{when(d.event.created_at)}</dd>
            <dt>License</dt>
            <dd>
              {m.license.id}
              {m.license.attribution && <div className="small">{m.license.attribution}</div>}
              {m.license.url && <div className="small mono">{m.license.url}</div>}
            </dd>
            <dt>Capabilities</dt>
            <dd>{m.capabilities.join(', ')}</dd>
            <dt>Languages</dt>
            <dd>{m.languages.join(', ')}</dd>
          </dl>
          {d.verification.warnings.length > 0 && (
            <ul className="warnings">
              {d.verification.warnings.map((w, i) => (
                <li key={i}>
                  {w.code}: {w.message}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Runtime and resources">
          <dl>
            <dt>Format / runtime</dt>
            <dd>
              {m.runtime.format} / {m.runtime.family} {m.runtime.requirement}
            </dd>
            <dt>Browser features</dt>
            <dd>{m.runtime.browser_features.join(', ') || 'none declared'}</dd>
            <dt>Chat template</dt>
            <dd>{m.runtime.chat_template?.source ?? 'not declared'}</dd>
            <dt>Context length</dt>
            <dd>{m.requirements.context_length}</dd>
            <dt>Memory</dt>
            <dd>
              {m.requirements.memory_mb
                ? `${m.requirements.memory_mb.value} MB (${m.requirements.memory_mb.basis}, ctx ${m.requirements.memory_mb.context_length})`
                : 'unknown (not reported: not assumed to fit)'}
            </dd>
            <dt>Hardware profiles</dt>
            <dd>{m.requirements.hardware_profiles?.join(', ') || 'not reported'}</dd>
            <dt>This browser</dt>
            <dd>
              {support?.supported ? `executable operations: ${support.executableOperations.join(', ')}` : <span className="error">{support?.reasons.join('; ')}</span>}
            </dd>
          </dl>
        </Section>
      </div>

      {m.kind === 'lora' && (
        <Section title="Exact base dependency">
          {dep?.ok ? (
            <p data-testid="lora-dependency" data-ok="true">
              Base resolved exactly: <a onClick={() => go({ page: 'model', id: dep.base!.eventId })}>{dep.base!.name}</a> (release {dep.base!.eventId.slice(0, 16)}…, manifest and weight
              hashes match). Combined download {formatBytes(dep.totalBytes)}, missing {formatBytes(dep.missingBytes)}.
            </p>
          ) : (
            <div className="warn-box" data-testid="lora-dependency" data-ok="false">
              <strong>Blocked: adapter execution is not allowed for this release.</strong>
              <ul>
                {dep?.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="small mono">
            Declared base: release {m.base?.release_id} · manifest {m.base?.manifest_sha256} · weights {m.base?.files.map((f) => `${f.sha256.slice(0, 16)}… (${formatBytes(f.size)})`).join(', ')}
          </p>
        </Section>
      )}

      <Section
        title="Files"
        actions={
          <div className="actions">
            {!synthetic && missing.length > 0 && (
              <button className="primary" onClick={download} disabled={downloading || !settings.networkSync} data-testid="download">
                Download &amp; verify ({formatBytes(missingBytes)})
              </button>
            )}
            {downloading && <button onClick={() => files.forEach((f) => artifacts.cancel(f.sha256))}>Cancel</button>}
            {files.some((f) => artifacts.isCached(f.sha256)) && (
              <button onClick={() => Promise.all(m.files.map((f) => artifacts.remove(f.sha256)))} data-testid="remove-cached">
                Remove cached files
              </button>
            )}
            {!synthetic && support?.supported && !blocked && (
              <button onClick={run} data-testid="run">
                Run…
              </button>
            )}
          </div>
        }
      >
        {msg && <p className="error">{msg}</p>}
        {!settings.networkSync && <p className="hint">Network sync is off: downloads are disabled.</p>}
        <table className="files">
          <thead>
            <tr>
              <th>Role / path</th>
              <th>Size</th>
              <th>SHA-256</th>
              <th>Locations</th>
              <th>Local</th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => {
              const st = artifacts.downloads.get(f.sha256);
              const role = m.files.find((x) => x.sha256 === f.sha256)?.role ?? 'weights (base)';
              return (
                <tr key={f.sha256} data-testid="file-row" data-sha={f.sha256}>
                  <td>
                    <div>{role}</div>
                    <code>{f.path}</code>
                  </td>
                  <td>{formatBytes(f.size)}</td>
                  <td className="mono small">{f.sha256}</td>
                  <td className="locations">
                    {f.locations.length === 0 && <em>none</em>}
                    {f.locations.map((l, i) => (
                      <div key={i} className="small">
                        <Badge tone="info">{l.transport}</Badge> <span className="mono">{l.uri.length > 90 ? l.uri.slice(0, 90) + '…' : l.uri}</span>
                        {l.path && <span> · path {l.path}</span>}
                      </div>
                    ))}
                  </td>
                  <td data-testid="file-status">
                    {artifacts.isCached(f.sha256) ? (
                      <Badge tone="ok">verified</Badge>
                    ) : st ? (
                      <div>
                        <Badge tone={st.status === 'failed' ? 'bad' : 'info'}>{st.status}</Badge>
                        {st.status === 'downloading' && <Progress value={st.bytes} max={st.size} />}
                        {st.status === 'downloading' && <div className="small">{formatBytes(st.bytes)} via {st.source}</div>}
                        {st.error && <div className="small error">{st.error}</div>}
                        {(st.status === 'failed' || st.status === 'canceled') && <button onClick={() => artifacts.download([f])}>Retry</button>}
                      </div>
                    ) : (
                      <Badge tone="muted">not cached</Badge>
                    )}
                    {st && st.attempts.length > 0 && (
                      <details className="attempts">
                        <summary>{st.attempts.length} attempt(s)</summary>
                        <ul>
                          {st.attempts.map((a, i) => (
                            <li key={i} className={a.ok ? '' : 'error'}>
                              {a.ok ? '✓' : '✗'} {a.transport} {formatBytes(a.bytes)} {a.error ?? 'verified'}
                              {a.peerBytes !== undefined && ` · peers ${formatBytes(a.peerBytes)} / web seed ${formatBytes(a.webSeedBytes ?? 0)}`}
                              <div className="mono small">{a.source.slice(0, 120)}</div>
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <Section title="Provenance">
        <ul>
          {d.sources.map((s) => (
            <li key={s.id}>
              <Badge tone={s.enabled ? 'info' : 'muted'}>{s.type}</Badge> {s.label} · observed {when(s.observedAt)}
              {!s.enabled && ' (disabled)'}
            </li>
          ))}
        </ul>
        <details>
          <summary>Original signed event</summary>
          <pre className="raw">{JSON.stringify(d.event, null, 2)}</pre>
        </details>
        <details>
          <summary>Manifest (exact bytes, as hashed)</summary>
          <pre className="raw">{d.manifestJson}</pre>
        </details>
      </Section>
    </div>
  );
}
