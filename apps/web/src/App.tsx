import { useApp, useChanges } from './lib/app.tsx';
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
  const { route, go, settings, init, live } = useApp();
  useChanges(live);
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
          <span className={init?.persistent ? 'pill ok' : 'pill warn'} title="Local catalog storage">
            {init ? (init.persistent ? 'catalog: OPFS' : 'catalog: memory only') : 'catalog: opening…'}
          </span>
        </div>
      </header>
      <main>
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
