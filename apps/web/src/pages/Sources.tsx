import { useEffect, useState, type ReactNode } from 'react';
import type { SourceRecord, CatalogStats } from '@wexare/catalog';
import { decode } from 'nostr-tools/nip19';
import type { NostrEvent, VerifiedCatalogAnnouncement } from '@wexare/protocol';
import { useApp, useChanges } from '../lib/app.tsx';
import { fetchArchive, parseAnnouncement } from '../lib/archive-import.ts';
import { capabilities, runtime } from '../lib/runtime.ts';
import { exportSettings, sanitize, type Settings } from '../lib/settings.ts';
import { formatBytes, shortId, when } from '../lib/format.ts';
import type { StagedImport } from '../workers/catalog-api.ts';
import { Badge, Fingerprint, Progress, Section } from '../components/common.tsx';

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function ListEditor({ label, value, onSave, testid }: { label: string; value: string[]; onSave: (v: string[]) => void; testid?: string }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => setText(value.join('\n')), [value]);
  return (
    <label className="list-editor">
      {label}
      <textarea rows={Math.max(2, value.length + 1)} value={text} onChange={(e) => setText(e.target.value)} data-testid={testid} />
      <button onClick={() => onSave(lines(text))} disabled={text === value.join('\n')}>
        Save
      </button>
    </label>
  );
}

export function Sources() {
  const { settings, updateSettings, live, catalog, catalogVersion, bump, artifacts } = useApp();
  useChanges(live);
  useChanges(artifacts);
  const [sources, setSources] = useState<SourceRecord[]>([]);
  const [stats, setStats] = useState<(CatalogStats & { dbBytes: number }) | null>(null);
  const set = (fn: (s: Settings) => Settings) => updateSettings(fn);

  useEffect(() => {
    void catalog.listSources().then(setSources);
    void catalog.stats().then(setStats);
  }, [catalog, catalogVersion]);

  return (
    <div className="sources">
      <Section title="Network">
        <label className="check big">
          <input
            type="checkbox"
            checked={settings.networkSync}
            onChange={(e) => set((s) => ({ ...s, networkSync: e.target.checked }))}
            data-testid="network-toggle"
          />{' '}
          Network synchronization (relay connections and downloads). Turn off for the offline demonstration: local search and cached inference keep working.
        </label>
      </Section>

      <Section title="Relays (live discovery)">
        <table className="files">
          <thead>
            <tr>
              <th>Relay</th>
              <th>State</th>
              <th>Received</th>
              <th>Accepted</th>
              <th>Duplicate</th>
              <th>Rejected</th>
              <th>Unknown profile</th>
              <th>Catalog ann.</th>
            </tr>
          </thead>
          <tbody>
            {settings.relays.map((url) => {
              const s = live.states.get(url);
              return (
                <tr key={url} data-testid="relay-row" data-relay={url} data-state={s?.status ?? 'idle'}>
                  <td className="mono small">{url}</td>
                  <td>
                    <Badge tone={s?.status === 'live' ? 'ok' : s?.status === 'error' || s?.status === 'closed' ? 'bad' : 'info'}>{s?.status ?? 'idle'}</Badge>
                    {s?.error && <div className="small error">{s.error}</div>}
                  </td>
                  <td>{s?.received ?? 0}</td>
                  <td>{s?.accepted ?? 0}</td>
                  <td>{s?.duplicates ?? 0}</td>
                  <td>{s?.rejected ?? 0}</td>
                  <td>{s?.unknownProfile ?? 0}</td>
                  <td>{s?.announcements ?? 0}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="actions">
          <button onClick={() => live.start(settings.relays)} disabled={!settings.networkSync}>
            Reconnect
          </button>
        </div>
        <ListEditor label="Relay URLs (one per line)" value={settings.relays} onSave={(v) => set((s) => ({ ...s, relays: v.filter((u) => /^wss?:\/\//.test(u)) }))} testid="relays" />
        {live.rejections.length > 0 && (
          <details>
            <summary>Recently rejected events ({live.rejections.length})</summary>
            <ul className="small">
              {live.rejections.slice(0, 30).map((r, i) => (
                <li key={i}>
                  <code>{r.code}</code> {shortId(r.id, 16)} from {r.relay}: {r.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <ImportArchive />

      <Section title="Catalog sources">
        {sources.length === 0 && <p className="empty">No sources yet.</p>}
        <table className="files">
          <thead>
            <tr>
              <th>Source</th>
              <th>Builder / URL</th>
              <th>Records</th>
              <th>Coverage</th>
              <th>Last import</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sources.map((s) => (
              <tr key={s.id} data-testid="source-row" data-source={s.id} data-count={s.memberCount}>
                <td>
                  <Badge tone="info">{s.type}</Badge> {s.label}
                </td>
                <td>{s.builderPubkey ? <Fingerprint pubkey={s.builderPubkey} /> : <span className="mono small">{s.url}</span>}</td>
                <td>{s.memberCount}</td>
                <td className="small">
                  {(s.details.coverage as { statement?: string; relays?: { url: string; state: string }[] } | undefined)?.relays?.map((r) => (
                    <div key={r.url}>
                      {r.url}: <Badge tone={r.state === 'caught-up' ? 'ok' : 'warn'}>{r.state}</Badge>
                    </div>
                  )) ?? (s.type === 'relay' ? 'retained + new events from this relay' : '—')}
                </td>
                <td>{when(s.lastImportAt)}</td>
                <td>
                  <label className="check">
                    <input type="checkbox" checked={s.enabled} onChange={(e) => catalog.setSourceEnabled(s.id, e.target.checked).then(bump)} /> enabled
                  </label>
                  <button
                    onClick={async () => {
                      await catalog.removeSource(s.id);
                      if (s.builderPubkey) set((x) => ({ ...x, catalogs: x.catalogs.filter((c) => c.builderPubkey !== s.builderPubkey) }));
                      bump();
                    }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">Removing or disabling a source recomputes membership; records still supplied by another source stay.</p>
      </Section>

      <Section title="Gateways, mirrors and publishers">
        <div className="row2">
          <ListEditor label="IPFS gateways" value={settings.ipfsGateways} onSave={(v) => set((s) => ({ ...s, ipfsGateways: v }))} />
          <ListEditor label="Arweave gateways" value={settings.arweaveGateways} onSave={(v) => set((s) => ({ ...s, arweaveGateways: v }))} />
          <ListEditor
            label="Preferred publisher keys (hex or npub)"
            value={settings.preferredPublishers}
            onSave={(v) =>
              set((s) => ({
                ...s,
                preferredPublishers: v
                  .map((k) => {
                    try {
                      return k.startsWith('npub') ? (decode(k).data as string) : k;
                    } catch {
                      return '';
                    }
                  })
                  .filter((k) => /^[0-9a-f]{64}$/.test(k)),
              }))
            }
          />
          <ListEditor label="Operator status endpoints" value={settings.operatorStatusUrls} onSave={(v) => set((s) => ({ ...s, operatorStatusUrls: v }))} />
        </div>
        <fieldset>
          <legend>Torrents (WebRTC peers via WebSocket trackers)</legend>
          <label className="check">
            <input type="checkbox" checked={settings.torrent.enabled} onChange={(e) => set((s) => ({ ...s, torrent: { ...s.torrent, enabled: e.target.checked } }))} /> use torrent sources
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.torrent.preferForArchives} onChange={(e) => set((s) => ({ ...s, torrent: { ...s.torrent, preferForArchives: e.target.checked } }))} /> try torrents
            first for catalog archives
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.torrent.seed} onChange={(e) => set((s) => ({ ...s, torrent: { ...s.torrent, seed: e.target.checked } }))} data-testid="browser-seed" />{' '}
            seed completed torrents from this tab (opt-in; stops when the tab closes)
          </label>
          <label>
            HTTP web-seed fallback delay (ms, -1 = never)
            <input
              type="number"
              value={settings.torrent.webSeedDelayMs}
              onChange={(e) => set((s) => ({ ...s, torrent: { ...s.torrent, webSeedDelayMs: Number(e.target.value) } }))}
              data-testid="webseed-delay"
            />
          </label>
          <ListEditor label="Trackers" value={settings.torrent.trackers} onSave={(v) => set((s) => ({ ...s, torrent: { ...s.torrent, trackers: v } }))} />
        </fieldset>
      </Section>

      <Diagnostics stats={stats} />
      <OperatorStatus />

      <Section title="Configuration">
        <div className="actions">
          <button
            onClick={() => {
              const blob = new Blob([exportSettings(settings)], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = 'wexare-client-config.json';
              a.click();
              URL.revokeObjectURL(a.href);
            }}
            data-testid="export-config"
          >
            Export configuration
          </button>
          <label className="file-btn">
            Import configuration
            <input
              type="file"
              accept="application/json"
              data-testid="import-config"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const next = sanitize(JSON.parse(await f.text()));
                updateSettings(() => next);
              }}
            />
          </label>
          <button
            onClick={async () => {
              if (!confirm('Delete every record from the local catalog? Cached model files are kept.')) return;
              await catalog.resetCatalog();
              bump();
            }}
          >
            Reset local catalog
          </button>
        </div>
        <p className="hint">Exports contain public configuration only (relays, gateways, trusted catalog builders, preferences). Publishing keys never enter the browser.</p>
      </Section>
    </div>
  );
}

function ImportArchive() {
  const { settings, updateSettings, catalog, live, artifacts, bump } = useApp();
  const [annText, setAnnText] = useState('');
  const [eventId, setEventId] = useState('');
  const [ann, setAnn] = useState<VerifiedCatalogAnnouncement | null>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [status, setStatus] = useState<ReactNode>('');
  const [progress, setProgress] = useState<{ bytes: number; total: number; peerBytes?: number; webSeedBytes?: number; source: string } | null>(null);
  const [staged, setStaged] = useState<StagedImport | null>(null);
  const [transfer, setTransfer] = useState<{ transport: string; peerBytes?: number; webSeedBytes?: number; source: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const inspect = (input: unknown) => {
    setStaged(null);
    setTransfer(null);
    const r = parseAnnouncement(input);
    if (!r.ok) {
      setAnn(null);
      setStatus(<span className="error">Announcement rejected: {r.error}</span>);
    } else {
      setAnn(r.value);
      setStatus('');
    }
  };

  const fetchAndStage = async () => {
    if (!ann) return;
    setBusy(true);
    setStatus('');
    try {
      let bytes: Uint8Array;
      if (zipFile) {
        bytes = new Uint8Array(await zipFile.arrayBuffer());
        setTransfer({ transport: 'local file', source: zipFile.name });
      } else {
        if (!settings.networkSync) throw new Error('Network sync is off: choose a local ZIP file instead.');
        const r = await fetchArchive(ann, settings, settings.torrent.enabled ? artifacts.torrent : undefined, setProgress);
        bytes = r.bytes;
        const ok = r.attempts.find((a) => a.ok)!;
        setTransfer({ transport: ok.transport, source: ok.source, ...(ok.peerBytes !== undefined ? { peerBytes: ok.peerBytes, webSeedBytes: ok.webSeedBytes } : {}) });
        for (const a of r.attempts) artifacts.stats.recentAttempts.unshift(a);
        if (ok.peerBytes !== undefined) {
          artifacts.stats.peerBytes += ok.peerBytes;
          artifacts.stats.webSeedBytes += ok.webSeedBytes ?? 0;
        }
        artifacts.stats.bytesByTransport[ok.transport] = (artifacts.stats.bytesByTransport[ok.transport] ?? 0) + ok.bytes;
      }
      const r = await catalog.stageArchive(bytes, ann.event);
      if (!r.ok) {
        setStatus(<span className="error">Archive rejected: {r.errors.map((e) => `${e.code}: ${e.message}`).join('; ')}</span>);
      } else setStaged(r.staged);
    } catch (e) {
      const attempts = (e as { attempts?: { source: string; error?: string }[] }).attempts;
      setStatus(
        <span className="error">
          {(e as Error).message}
          {attempts?.map((a, i) => (
            <div key={i} className="small">
              {a.source.slice(0, 100)}: {a.error}
            </div>
          ))}
        </span>,
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const commit = async () => {
    if (!staged || !ann) return;
    setBusy(true);
    const label = `catalog by ${shortId(staged.builderPubkey, 10)} (${staged.inventory.collection_policy})`;
    const r = await catalog.commitArchive(staged.token, label);
    updateSettings((s) => ({
      ...s,
      catalogs: [...s.catalogs.filter((c) => c.builderPubkey !== staged.builderPubkey), { builderPubkey: staged.builderPubkey, label, announcement: ann.event }],
    }));
    setStatus(
      <span data-testid="import-done">
        Imported {r.total} records ({r.added} new, {r.pruned} pruned) in {r.ms} ms.
      </span>,
    );
    setStaged(null);
    setBusy(false);
    bump();
  };

  const seen = [...live.announcements.values()].sort((a, b) => b.event.created_at - a.event.created_at);

  return (
    <Section title="Import a catalog archive">
      <div className="import-grid">
        <label>
          Paste a signed archive announcement (JSON)
          <textarea rows={4} value={annText} onChange={(e) => setAnnText(e.target.value)} data-testid="announcement-json" />
          <button onClick={() => inspect(annText)} data-testid="inspect-announcement">
            Inspect
          </button>
        </label>
        <div>
          <label>
            …or its event ID (looked up on configured relays)
            <input value={eventId} onChange={(e) => setEventId(e.target.value.trim())} placeholder="64 hex characters" data-testid="announcement-id" />
          </label>
          <button
            disabled={!/^[0-9a-f]{64}$/.test(eventId) || !settings.networkSync}
            onClick={async () => {
              setStatus('Looking up…');
              const r = await live.lookupEvent(eventId, settings.relays);
              if (r) inspect(r.event);
              else setStatus(<span className="error">Not found on the configured relays.</span>);
            }}
            data-testid="lookup-announcement"
          >
            Look up
          </button>
          <label className="file-btn">
            …or load an announcement file
            <input type="file" accept="application/json" onChange={async (e) => e.target.files?.[0] && inspect(await e.target.files[0].text())} data-testid="announcement-file" />
          </label>
          <label className="file-btn">
            Optional: local ZIP (instead of downloading)
            <input type="file" accept=".zip,application/zip" onChange={(e) => setZipFile(e.target.files?.[0] ?? null)} data-testid="zip-file" />
          </label>
          {zipFile && <div className="small">Using local file {zipFile.name} ({formatBytes(zipFile.size)})</div>}
        </div>
      </div>
      {seen.length > 0 && (
        <details>
          <summary>Archive announcements seen on relays ({seen.length})</summary>
          <ul>
            {seen.map(({ event, relays }) => (
              <li key={event.id}>
                <Fingerprint pubkey={event.pubkey} /> {event.content.slice(0, 100)} · {when(event.created_at)} · {relays.size} relay(s){' '}
                <button onClick={() => inspect(event as NostrEvent)}>Inspect</button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {ann && (
        <div className="staging" data-testid="announcement-verified">
          <h3>Signed announcement verified</h3>
          <dl>
            <dt>Builder (review before trusting)</dt>
            <dd>
              <Fingerprint pubkey={ann.event.pubkey} /> <span className="mono small" data-testid="builder-pubkey">{ann.event.pubkey}</span>
              {settings.catalogs.some((c) => c.builderPubkey === ann.event.pubkey) ? <Badge tone="info">previously imported</Badge> : <Badge tone="warn">new builder</Badge>}
            </dd>
            <dt>Snapshot</dt>
            <dd>{ann.description}</dd>
            <dt>ZIP</dt>
            <dd className="mono small">
              {ann.zipSha256} · {formatBytes(ann.zipSize)}
            </dd>
            <dt>Locations</dt>
            <dd className="small">
              {ann.locations.map((l) => (
                <div key={l.uri}>
                  <Badge tone="info">{l.transport}</Badge> <span className="mono">{l.uri}</span>
                </div>
              ))}
              {ann.magnet && (
                <div>
                  <Badge tone="info">torrent</Badge> <span className="mono">{ann.magnet.slice(0, 80)}…</span>
                </div>
              )}
            </dd>
          </dl>
          <p className="hint">The signature proves who announced these exact archive bytes. It does not prove the archive lists every published release.</p>
          {!staged && (
            <button className="primary" onClick={fetchAndStage} disabled={busy} data-testid="fetch-archive">
              {zipFile ? 'Verify local ZIP' : 'Fetch & verify archive'}
            </button>
          )}
          {progress && (
            <div>
              <Progress value={progress.bytes} max={progress.total} /> {formatBytes(progress.bytes)} via {progress.source.slice(0, 60)}
              {progress.peerBytes !== undefined && ` · peers ${formatBytes(progress.peerBytes)} / web seed ${formatBytes(progress.webSeedBytes ?? 0)}`}
            </div>
          )}
          {transfer && (
            <p className="small" data-testid="archive-transfer" data-transport={transfer.transport} data-peer-bytes={transfer.peerBytes ?? 0} data-webseed-bytes={transfer.webSeedBytes ?? 0}>
              Received via {transfer.transport}
              {transfer.peerBytes !== undefined && `: ${formatBytes(transfer.peerBytes)} from WebRTC peers, ${formatBytes(transfer.webSeedBytes ?? 0)} from HTTP web seeds`} ·{' '}
              <span className="mono">{transfer.source.slice(0, 80)}</span>
            </p>
          )}
          {staged && (
            <div className="staged" data-testid="staged">
              <p>
                <strong data-testid="staged-count">{staged.recordCount}</strong> signed release records verified in {staged.verifyMs} ms ({staged.alreadyKnown} already known). Policy{' '}
                <code>{staged.inventory.collection_policy}</code>, built {when(staged.inventory.build_time)}.
              </p>
              <p className="small">{staged.inventory.coverage.statement}</p>
              <ul className="small">
                {staged.inventory.coverage.relays.map((r) => (
                  <li key={r.url}>
                    {r.url}: <Badge tone={r.state === 'caught-up' ? 'ok' : 'warn'}>{r.state}</Badge> {r.events ?? ''} {r.notes}
                  </li>
                ))}
              </ul>
              <button className="primary" onClick={commit} disabled={busy} data-testid="commit-import">
                Trust this builder &amp; import
              </button>{' '}
              <button onClick={() => (catalog.discardStaged(staged.token), setStaged(null))}>Discard</button>
            </div>
          )}
        </div>
      )}
      {status && <div className="status">{status}</div>}
    </Section>
  );
}

function Diagnostics({ stats }: { stats: (CatalogStats & { dbBytes: number }) | null }) {
  const { artifacts, live, init } = useApp();
  const totals = [...live.states.values()].reduce(
    (a, s) => ({ accepted: a.accepted + s.accepted, rejected: a.rejected + s.rejected, duplicates: a.duplicates + s.duplicates, unknown: a.unknown + s.unknownProfile }),
    { accepted: 0, rejected: 0, duplicates: 0, unknown: 0 },
  );
  const t = artifacts.stats;
  const [usage, setUsage] = useState<string>('');
  useEffect(() => {
    void artifacts.usage().then((u) => setUsage(`${formatBytes(u.usage)} of ${formatBytes(u.quota)} (${u.persisted ? 'persistent' : 'best-effort'})`)).catch(() => setUsage('unavailable'));
  }, [artifacts, t.verified]);
  return (
    <Section title="Diagnostics">
      <div className="diag-grid">
        <div>
          <h3>Local catalog</h3>
          <dl data-testid="catalog-stats">
            <dt>Storage</dt>
            <dd>
              {init?.vfs} · SQLite {init?.sqliteVersion} · schema v{init?.schemaVersion}
            </dd>
            <dt>Records</dt>
            <dd data-testid="stat-releases">
              {stats?.releases ?? '—'} releases ({stats?.synthetic ?? 0} synthetic) · {stats?.sources ?? 0} sources · {stats?.conflicts ?? 0} label conflicts
            </dd>
            <dt>Database size</dt>
            <dd data-testid="stat-dbbytes">{stats ? formatBytes(stats.dbBytes) : '—'}</dd>
            <dt>Live events this session</dt>
            <dd>
              {totals.accepted} accepted · {totals.duplicates} duplicate · {totals.rejected} rejected · {totals.unknown} unknown profile
            </dd>
          </dl>
        </div>
        <div>
          <h3>Downloads</h3>
          <dl data-testid="transfer-stats">
            <dt>Bytes by transport</dt>
            <dd>
              {Object.entries(t.bytesByTransport)
                .map(([k, v]) => `${k} ${formatBytes(v)}`)
                .join(' · ') || 'none yet'}
            </dd>
            <dt>Torrent bytes</dt>
            <dd data-testid="peer-bytes">
              peers {formatBytes(t.peerBytes)} · HTTP web seeds {formatBytes(t.webSeedBytes)} · uploaded {formatBytes(artifacts.torrent.totals.uploadedBytes)}
            </dd>
            <dt>Integrity</dt>
            <dd>
              {t.verified} verified · {t.hashFailures} hash mismatches · {t.sizeFailures} size mismatches
            </dd>
            <dt>Browser storage</dt>
            <dd>{usage}</dd>
          </dl>
          {t.recentAttempts.length > 0 && (
            <details>
              <summary>Recent transfer attempts</summary>
              <ul className="small">
                {t.recentAttempts.slice(0, 20).map((a, i) => (
                  <li key={i} className={a.ok ? '' : 'error'}>
                    {a.ok ? '✓' : '✗'} {a.transport} {formatBytes(a.bytes)} {a.error ?? 'hash verified'} <span className="mono">{a.source.slice(0, 80)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <div>
          <h3>Runtime</h3>
          <dl data-testid="runtime-info">
            <dt>Runtime</dt>
            <dd>
              {capabilities.runtime} {capabilities.version} (GGUF, CPU/WASM)
            </dd>
            <dt>Features</dt>
            <dd>
              {Object.entries(capabilities.features)
                .map(([k, v]) => `${k} ${v ? '✓' : '✗'}`)
                .join(' · ')}
            </dd>
            <dt>Threads</dt>
            <dd>
              cross-origin isolated {capabilities.crossOriginIsolated ? 'yes' : 'no'} · {capabilities.hardwareConcurrency} logical cores
              {runtime.loaded && ` · loaded with ${runtime.loaded.threads} threads (${runtime.loaded.multithread ? 'multithreaded' : 'single-threaded'})`}
            </dd>
            <dt>LoRA adapters</dt>
            <dd>{capabilities.adapterExecution.supported ? `supported: ${capabilities.adapterExecution.reason}` : capabilities.adapterExecution.reason}</dd>
            <dt>Resident model</dt>
            <dd className="mono small">{runtime.loaded?.key ?? 'none'}</dd>
          </dl>
        </div>
      </div>
    </Section>
  );
}

function OperatorStatus() {
  const { settings } = useApp();
  const [rows, setRows] = useState<{ url: string; data?: { operator: string; relays: { url: string; status: string; possiblyIncomplete: boolean; incompleteReasons: string[] }[]; totals: CatalogStats }; error?: string }[]>([]);
  const refresh = async () => {
    setRows(
      await Promise.all(
        settings.operatorStatusUrls.map(async (u) => {
          try {
            const r = await fetch(`${u.replace(/\/$/, '')}/status`, { signal: AbortSignal.timeout(3000) });
            return { url: u, data: await r.json() };
          } catch (e) {
            return { url: u, error: (e as Error).message };
          }
        }),
      ),
    );
  };
  return (
    <Section
      title="Operator status (optional)"
      actions={
        <button onClick={refresh} disabled={!settings.networkSync}>
          Refresh
        </button>
      }
    >
      <p className="hint">Indexers expose health only. This client never queries an indexer for search results.</p>
      {rows.map((r) => (
        <div key={r.url} className="small">
          <strong>{r.url}</strong>{' '}
          {r.error ? (
            <span className="error">{r.error}</span>
          ) : (
            <>
              {r.data!.operator}: {r.data!.totals.releases} releases ·{' '}
              {r.data!.relays.map((x) => (
                <span key={x.url}>
                  {x.url} <Badge tone={x.possiblyIncomplete ? 'warn' : x.status === 'live' ? 'ok' : 'info'}>{x.possiblyIncomplete ? 'possibly incomplete' : x.status}</Badge>{' '}
                </span>
              ))}
            </>
          )}
        </div>
      ))}
    </Section>
  );
}
