import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createCatalogClient, type CatalogClient } from './catalog-client.ts';
import { LiveDiscovery } from './live.ts';
import { ArtifactManager } from './artifacts.ts';
import { loadSettings, saveSettings, type Settings } from './settings.ts';
import type { InitResult } from '../workers/catalog-api.ts';

export type Route = { page: 'discover' | 'library' | 'playground' | 'sources' } | { page: 'model'; id: string };

interface AppState {
  settings: Settings;
  updateSettings: (fn: (s: Settings) => Settings) => void;
  catalog: CatalogClient;
  live: LiveDiscovery;
  artifacts: ArtifactManager;
  init: InitResult | null;
  /** Increments whenever catalog contents change. */
  catalogVersion: number;
  bump: () => void;
  route: Route;
  go: (r: Route | string) => void;
  playgroundPreset: { explicit?: Record<string, string>; single?: string } | null;
  setPlaygroundPreset: (p: AppState['playgroundPreset']) => void;
}

const Ctx = createContext<AppState | null>(null);

let singletons: { catalog: CatalogClient; live: LiveDiscovery; artifacts: ArtifactManager } | null = null;
let currentSettings: () => Settings = () => loadSettings();
function services(getSettings: () => Settings) {
  currentSettings = getSettings;
  if (!singletons) {
    const catalog = createCatalogClient();
    singletons = { catalog, live: new LiveDiscovery(catalog), artifacts: new ArtifactManager(catalog, () => currentSettings()) };
  }
  return singletons;
}

let initPromise: Promise<InitResult> | null = null;
function initOnce(catalog: CatalogClient, artifacts: ArtifactManager): Promise<InitResult> {
  initPromise ??= catalog.init().then(async (r) => {
    await artifacts.init().catch((e) => console.warn('artifact cache init', e));
    return r;
  });
  return initPromise;
}

function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  const [page, id] = h.split('/');
  if (page === 'model' && id) return { page: 'model', id };
  if (page === 'library' || page === 'playground' || page === 'sources') return { page };
  return { page: 'discover' };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Module-level singletons: the OPFS SAH pool allows one connection, so the
  // catalog worker must never be created twice (e.g. by StrictMode re-renders).
  const { catalog, live, artifacts } = services(() => settingsRef.current);
  const [init, setInit] = useState<InitResult | null>(null);
  const [catalogVersion, setVersion] = useState(0);
  const [route, setRoute] = useState<Route>(parseHash);
  const [playgroundPreset, setPlaygroundPreset] = useState<AppState['playgroundPreset']>(null);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    void initOnce(catalog, artifacts).then((r) => {
      setInit(r);
      bump();
    });
  }, [catalog, artifacts, bump]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  // Live relay sync follows the network toggle and the relay list.
  const relayKey = settings.relays.join('|');
  useEffect(() => {
    if (!init) return;
    if (settings.networkSync) live.start(settings.relays);
    else live.stop();
    return () => live.stop();
  }, [init, live, settings.networkSync, relayKey]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const onUpdate = () => {
      clearTimeout(t);
      t = setTimeout(bump, 250);
    };
    live.addEventListener('catalog-updated', onUpdate);
    artifacts.addEventListener('change', onUpdate);
    return () => {
      live.removeEventListener('catalog-updated', onUpdate);
      artifacts.removeEventListener('change', onUpdate);
    };
  }, [live, artifacts, bump]);

  const updateSettings = useCallback((fn: (s: Settings) => Settings) => {
    setSettings((s) => {
      const next = fn(s);
      saveSettings(next);
      return next;
    });
  }, []);

  const go = useCallback((r: Route | string) => {
    location.hash = typeof r === 'string' ? r : r.page === 'model' ? `#/model/${r.id}` : `#/${r.page}`;
  }, []);

  const value: AppState = { settings, updateSettings, catalog, live, artifacts, init, catalogVersion, bump, route, go, playgroundPreset, setPlaygroundPreset };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside AppProvider');
  return v;
}

/** Re-render when an EventTarget emits 'change'. */
export function useChanges(target: EventTarget): number {
  const ref = useRef(0);
  return useSyncExternalStore(
    (cb) => {
      const h = () => {
        ref.current++;
        cb();
      };
      target.addEventListener('change', h);
      return () => target.removeEventListener('change', h);
    },
    () => ref.current,
  );
}
