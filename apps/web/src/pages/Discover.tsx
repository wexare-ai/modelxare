import { useEffect, useMemo, useState } from 'react';
import type { CatalogQuery, QueryPage, ReleaseSummary } from '@wexare/catalog';
import { useApp } from '../lib/app.tsx';
import { capabilities } from '../lib/runtime.ts';
import { formatBytes, when } from '../lib/format.ts';
import { Fingerprint, StatusBadges } from '../components/common.tsx';

type Mode = 'live' | 'archives' | 'combined';
const MODES: { id: Mode; label: string; sourceTypes: CatalogQuery['sourceTypes']; note: string }[] = [
  { id: 'live', label: 'Live', sourceTypes: ['relay'], note: 'Retained and new announcements observed on your configured relays. Not a list of every model everywhere.' },
  { id: 'archives', label: 'Archives', sourceTypes: ['catalog', 'manual'], note: 'Records from imported catalog snapshots, searched locally. Works offline.' },
  { id: 'combined', label: 'Combined', sourceTypes: undefined, note: 'All enabled sources merged; identical events are deduplicated, publishers kept distinct.' },
];
const CAPS = ['text-classification', 'summarization', 'text-generation', 'translation', 'sentiment-analysis', 'question-answering'];
const LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'und'];
const PAGE = 25;

function readMode(): Mode {
  try {
    return (localStorage.getItem('wexare.discover.mode') as Mode) || 'combined';
  } catch {
    return 'combined';
  }
}

export function Discover() {
  const { catalog, catalogVersion, go, init } = useApp();
  const [mode, setMode] = useState<Mode>(readMode);
  const [text, setText] = useState('');
  const [caps, setCaps] = useState<string[]>([]);
  const [langs, setLangs] = useState<string[]>([]);
  const [kind, setKind] = useState('');
  const [runtimeFamily, setRuntimeFamily] = useState('');
  const [format, setFormat] = useState('');
  const [license, setLicense] = useState('');
  const [maxMb, setMaxMb] = useState('');
  const [maxMem, setMaxMem] = useState('');
  const [unknownMem, setUnknownMem] = useState(false);
  const [hw, setHw] = useState('');
  const [cached, setCached] = useState('');
  const [synthetic, setSynthetic] = useState(false);
  const [orderBy, setOrderBy] = useState<NonNullable<CatalogQuery['orderBy']>>('relevance');
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<(QueryPage & { ms: number }) | null>(null);
  const [error, setError] = useState('');

  const query: CatalogQuery = useMemo(
    () => ({
      ...(text.trim() ? { text } : {}),
      ...(caps.length ? { capabilities: caps } : {}),
      ...(langs.length ? { languages: langs } : {}),
      ...(kind ? { kind: kind as 'model' | 'lora' } : {}),
      ...(runtimeFamily ? { runtimeFamily } : {}),
      ...(format ? { format } : {}),
      ...(license ? { license } : {}),
      ...(maxMb ? { maxDownloadBytes: Number(maxMb) * 1e6 } : {}),
      ...(maxMem ? { maxMemoryMb: Number(maxMem), includeUnknownMemory: unknownMem } : {}),
      ...(hw ? { hardwareProfile: hw } : {}),
      ...(cached ? { cached: cached === 'yes' } : {}),
      includeSynthetic: synthetic,
      sourceTypes: MODES.find((m) => m.id === mode)!.sourceTypes,
      orderBy: orderBy === 'relevance' && !text.trim() ? 'newest' : orderBy,
      limit: PAGE,
      offset,
    }),
    [text, caps, langs, kind, runtimeFamily, format, license, maxMb, maxMem, unknownMem, hw, cached, synthetic, mode, orderBy, offset],
  );

  useEffect(() => {
    if (!init) return;
    let stale = false;
    const t = setTimeout(() => {
      catalog
        .query(query)
        .then((p) => !stale && (setPage(p), setError('')))
        .catch((e) => !stale && setError(String(e.message ?? e)));
    }, 120);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [catalog, query, catalogVersion, init]);

  useEffect(() => setOffset(0), [text, caps, langs, kind, runtimeFamily, format, license, maxMb, maxMem, unknownMem, hw, cached, synthetic, mode]);
  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const m = MODES.find((x) => x.id === mode)!;

  return (
    <div className="discover">
      <div className="modes" role="tablist" aria-label="Discovery mode">
        {MODES.map((x) => (
          <button
            key={x.id}
            role="tab"
            aria-selected={mode === x.id}
            className={mode === x.id ? 'mode active' : 'mode'}
            onClick={() => {
              setMode(x.id);
              try {
                localStorage.setItem('wexare.discover.mode', x.id);
              } catch {
                // per-viewer convenience only
              }
            }}
          >
            {x.label}
          </button>
        ))}
        <p className="mode-note">{m.note}</p>
      </div>
      <div className="discover-grid">
        <form className="filters card" onSubmit={(e) => e.preventDefault()} aria-label="Search filters">
          <label>
            Search
            <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="name, description, capability…" data-testid="search-text" />
          </label>
          <fieldset>
            <legend>Capabilities (all required)</legend>
            {CAPS.map((c) => (
              <label key={c} className="check">
                <input type="checkbox" checked={caps.includes(c)} onChange={() => toggle(caps, setCaps, c)} /> {c}
              </label>
            ))}
          </fieldset>
          <fieldset>
            <legend>Languages (any)</legend>
            <div className="chips">
              {LANGS.map((l) => (
                <label key={l} className="check chip">
                  <input type="checkbox" checked={langs.includes(l)} onChange={() => toggle(langs, setLangs, l)} /> {l}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="row2">
            <label>
              Artifact
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">any</option>
                <option value="model">model</option>
                <option value="lora">LoRA</option>
              </select>
            </label>
            <label>
              Runtime
              <select value={runtimeFamily} onChange={(e) => setRuntimeFamily(e.target.value)}>
                <option value="">any</option>
                <option value="wllama">wllama</option>
                <option value="onnx-web">onnx-web</option>
                <option value="mlc-web">mlc-web</option>
              </select>
            </label>
            <label>
              Format
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="">any</option>
                <option value="gguf">gguf</option>
                <option value="onnx">onnx</option>
                <option value="mlc">mlc</option>
              </select>
            </label>
            <label>
              License
              <input value={license} onChange={(e) => setLicense(e.target.value)} placeholder="e.g. Apache-2.0" />
            </label>
            <label>
              Max download (MB)
              <input inputMode="numeric" value={maxMb} onChange={(e) => setMaxMb(e.target.value.replace(/\D/g, ''))} />
            </label>
            <label>
              Max memory (MB)
              <input inputMode="numeric" value={maxMem} onChange={(e) => setMaxMem(e.target.value.replace(/\D/g, ''))} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={unknownMem} onChange={(e) => setUnknownMem(e.target.checked)} disabled={!maxMem} /> include unknown memory requirements
          </label>
          <div className="row2">
            <label>
              Hardware profile
              <select value={hw} onChange={(e) => setHw(e.target.value)}>
                <option value="">any</option>
                <option value="cpu-wasm">cpu-wasm</option>
                <option value="webgpu">webgpu</option>
              </select>
            </label>
            <label>
              Cached
              <select value={cached} onChange={(e) => setCached(e.target.value)}>
                <option value="">any</option>
                <option value="yes">cached</option>
                <option value="no">not cached</option>
              </select>
            </label>
            <label>
              Order
              <select value={orderBy} onChange={(e) => setOrderBy(e.target.value as never)}>
                <option value="relevance">relevance</option>
                <option value="newest">newest</option>
                <option value="name">name</option>
                <option value="size">size</option>
              </select>
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} data-testid="include-synthetic" /> include synthetic test records
          </label>
          <p className="hint">Search runs locally on metadata only. It never downloads weights.</p>
        </form>
        <div className="results">
          <div className="results-head" data-testid="results-head">
            {page ? (
              <span>
                <strong data-testid="result-total">{page.total}</strong> result{page.total === 1 ? '' : 's'} · local query{' '}
                <span data-testid="query-ms">{page.ms}</span> ms
              </span>
            ) : (
              <span>Opening local catalog…</span>
            )}
            {error && <span className="error">{error}</span>}
          </div>
          {page?.items.length === 0 && <EmptyHint mode={mode} />}
          <ul className="result-list">
            {page?.items.map((r) => <ResultItem key={r.eventId} r={r} onOpen={() => go({ page: 'model', id: r.eventId })} />)}
          </ul>
          {page && page.total > PAGE && (
            <div className="pager">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                ← Previous
              </button>
              <span>
                {offset + 1}–{Math.min(offset + PAGE, page.total)} of {page.total}
              </span>
              <button disabled={offset + PAGE >= page.total} onClick={() => setOffset(offset + PAGE)}>
                Next →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyHint({ mode }: { mode: Mode }) {
  const { go } = useApp();
  return (
    <div className="empty">
      {mode === 'live' ? (
        <p>No releases observed on the configured relays yet. Check relay status, or publish with <code>pnpm demo:publish</code>.</p>
      ) : (
        <p>
          No matching records. Import a catalog archive in <a onClick={() => go({ page: 'sources' })}>Sources &amp; diagnostics</a>.
        </p>
      )}
    </div>
  );
}

function ResultItem({ r, onOpen }: { r: ReleaseSummary; onOpen: () => void }) {
  const support = useMemo(() => (r.synthetic ? { supported: false, reasons: ['synthetic record'] } : null), [r.synthetic]);
  const live = r.sourceIds.filter((s) => s.startsWith('relay:')).length;
  const archives = r.sourceIds.length - live;
  return (
    <li className="result">
      <button className="result-main" onClick={onOpen} data-testid="result-item" data-event-id={r.eventId}>
        <div className="result-title">
          <strong>{r.name}</strong> <span className="ver">v{r.version}</span> {r.kind === 'lora' && <span className="kind">LoRA</span>}
        </div>
        <p className="desc">{r.description}</p>
        <div className="meta">
          <Fingerprint pubkey={r.pubkey} />
          <span>{r.capabilities.join(', ')}</span>
          <span>{r.languages.join(', ')}</span>
          <span>{r.runtimeFamily}/{r.runtimeFormat}</span>
          <span>{formatBytes(r.downloadBytes)}</span>
          <span>memory: {r.memoryMb ? `${r.memoryMb} MB (${r.memoryBasis})` : 'unknown'}</span>
          <span>{r.licenseId}</span>
          <span title="Sources that supplied this exact event">
            {live ? `${live} relay${live > 1 ? 's' : ''}` : ''}
            {live && archives ? ' + ' : ''}
            {archives ? `${archives} catalog${archives > 1 ? 's' : ''}` : ''}
          </span>
          <span>{when(r.createdAt)}</span>
        </div>
        <SupportBadges r={r} fallback={support} />
      </button>
    </li>
  );
}

function SupportBadges({ r, fallback }: { r: ReleaseSummary; fallback: { supported: boolean; reasons: string[] } | null }) {
  const supportedHint = fallback ?? quickSupport(r);
  return <StatusBadges cached={r.cached ? 1 : 0} files={1} supported={supportedHint.supported} reasons={supportedHint.reasons} synthetic={r.synthetic} />;
}

/** Summary-level support hint; the detail page runs the full manifest check. */
function quickSupport(r: ReleaseSummary): { supported: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (r.runtimeFamily !== capabilities.runtime) reasons.push(`runtime ${r.runtimeFamily} not bundled`);
  if (r.runtimeFormat !== 'gguf') reasons.push(`format ${r.runtimeFormat} unsupported`);
  if (r.kind === 'lora' && !capabilities.adapterExecution.supported) reasons.push(capabilities.adapterExecution.reason);
  return { supported: reasons.length === 0, reasons };
}
