import { useEffect, useState } from 'react';
import { remoteHelp } from '@wexare/router';
import { useConnection, useStorage } from './engine.ts';
import { Home } from './Home.tsx';
import { ModelPage } from './ModelPage.tsx';
import { Settings } from './Settings.tsx';
import type { TaskId } from './models.ts';
import { useOnlineHelp } from './routing.ts';

const modelInHash = () => /^#\/model\/([0-9a-f]{64})$/.exec(location.hash)?.[1] ?? null;
const settingsInHash = () => location.hash === '#/settings';

const CONNECTION: Record<ReturnType<typeof useConnection>, string> = {
  connecting: 'Connecting',
  online: 'Up to date',
  offline: 'Offline, showing saved models',
};

export function App() {
  const { init, steppedAside } = useStorage();
  const connection = useConnection();
  const [modelId, setModelId] = useState(modelInHash);
  const [settings, setSettings] = useState(settingsInHash);
  const help = remoteHelp(useOnlineHelp());
  const [task, setTask] = useState<TaskId | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onHash = () => {
      setModelId(modelInHash());
      setSettings(settingsInHash());
      scrollTo(0, 0);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  if (steppedAside) {
    return (
      <div className="page">
        <main className="aside">
          <h1>weXare is open in another tab</h1>
          <p>It works in one tab at a time.</p>
          <button className="primary" onClick={() => location.reload()}>
            Use it here
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="top">
        <a className="wordmark" href="#/">
          <img src="./favicon.svg" alt="" width="26" height="26" />
          weXare
        </a>
        <span className="top-right">
          <span className={`connection ${connection}`}>{CONNECTION[connection]}</span>
          <a className="settings-link" href="#/settings">
            Settings
          </a>
        </span>
      </header>

      {init && !init.persistent && (
        <div className="note" role="status">
          <p>weXare can’t save anything in this tab right now. Close other weXare tabs, then reload.</p>
          <button className="secondary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}

      <main>
        {settings ? (
          <Settings back={() => (location.hash = '#/')} />
        ) : modelId ? (
          <ModelPage id={modelId} preferredTask={task} back={() => (location.hash = '#/')} />
        ) : (
          <Home task={task} setTask={setTask} query={query} setQuery={setQuery} open={(id) => (location.hash = `#/model/${id}`)} />
        )}
      </main>

      <footer>
        {help
          ? `Models run in this browser. With online help on, only steps no model here can do are sent to ${help.provider}.`
          : 'Models run in this browser. What you type is never sent anywhere.'}
      </footer>
    </div>
  );
}
