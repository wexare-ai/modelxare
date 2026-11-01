import { useApp, useChanges } from './lib/app.tsx';
import { confirmReset } from './components/common.tsx';
import { Discover } from './pages/Discover.tsx';
import { ModelDetail } from './pages/ModelDetail.tsx';
import { Library } from './pages/Library.tsx';
import { Playground } from './pages/Playground.tsx';
import { Sources } from './pages/Sources.tsx';

const TABS = [
  { page: 'discover', label: 'Discover' },
  { page: 'library', label: 'Model library' },
  { page: 'playground', label: 'Playground' },
  { page: 'sources', label: 'Sources & diagnostics' },
] as const;

export function App() {
  const { route, go, settings, init, live, session } = useApp();
  useChanges(live);
  useChanges(session);
  if (session.state === 'released') return <SteppedAside />;
  const liveCount = [...live.states.values()].filter((s) => s.status === 'live' || s.status === 'catching-up').length;
  const current = route.page === 'model' ? 'library' : route.page;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            w
          </span>
          <div>
            <strong>weXare micro-models</strong>
            <small>open, signed releases · local search · local inference</small>
          </div>
        </div>
        <nav aria-label="Main">
          {TABS.map((t) => (
            <button key={t.page} className={current === t.page ? 'tab active' : 'tab'} onClick={() => go({ page: t.page })}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="status-pills">
          <span className={settings.networkSync ? 'pill ok' : 'pill warn'} title="Relay sync and downloads">
            {settings.networkSync ? `network sync on · ${liveCount}/${settings.relays.length} relays` : 'network sync OFF'}
          </span>
          <span className={init?.persistent ? 'pill ok' : 'pill warn'} title={init?.error ? `Local catalog storage: ${init.error}` : 'Local catalog storage'}>
            {init ? (init.persistent ? 'catalog: OPFS' : 'catalog: memory only') : 'catalog: opening…'}
          </span>
        </div>
      </header>
      <main>
        {init && !init.persistent && <MemoryOnlyNotice reason={init.error} />}
        {route.page === 'discover' && <Discover />}
        {route.page === 'model' && <ModelDetail id={route.id} />}
        {route.page === 'library' && <Library />}
        {route.page === 'playground' && <Playground />}
        {route.page === 'sources' && <Sources />}
      </main>
      <footer>
        Proof of concept. Signatures prove who published a record and hashes prove byte integrity; neither is a quality endorsement. Searches, prompts and outputs stay on
        this device.
      </footer>
    </div>
  );
}

/** Another tab took the catalog over (only one tab at a time can hold it). */
function SteppedAside() {
  return (
    <div className="app">
      <main>
        <section className="card stepped-aside" data-testid="stepped-aside">
          <h2>weXare is open in another tab</h2>
          <p>Only one tab at a time can use the local catalog, so this one stepped aside. Nothing was lost.</p>
          <div className="actions">
            <button className="primary" onClick={() => location.reload()}>
              Use here
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

function MemoryOnlyNotice({ reason }: { reason?: string | undefined }) {
  const { resetLocalData } = useApp();
  return (
    <div className="notice" role="status" data-testid="memory-only">
      <p>
        <strong>The catalog is in memory only</strong>: {reason ?? 'this browser did not provide persistent storage (OPFS)'}. Search and downloads still work, but
        the catalog is not kept after this tab closes.
      </p>
      <button onClick={() => confirmReset(resetLocalData)}>Reset local data</button>
    </div>
  );
}
