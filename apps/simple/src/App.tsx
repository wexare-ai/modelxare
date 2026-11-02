import { useEffect, useState } from 'react';
import { useConnection, useStorage } from './engine.ts';
import { Home } from './Home.tsx';
import { ModelPage } from './ModelPage.tsx';
import type { TaskId } from './models.ts';

const modelInHash = () => /^#\/model\/([0-9a-f]{64})$/.exec(location.hash)?.[1] ?? null;

const CONNECTION: Record<ReturnType<typeof useConnection>, string> = {
  connecting: 'Connecting',
  online: 'Up to date',
  offline: 'Offline, showing saved models',
};

export function App() {
  const { init, steppedAside } = useStorage();
  const connection = useConnection();
  const [modelId, setModelId] = useState(modelInHash);
  const [task, setTask] = useState<TaskId | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onHash = () => {
      setModelId(modelInHash());
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
        <span className={`connection ${connection}`}>{CONNECTION[connection]}</span>
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
        {modelId ? (
          <ModelPage id={modelId} preferredTask={task} back={() => (location.hash = '#/')} />
        ) : (
          <Home task={task} setTask={setTask} query={query} setQuery={setQuery} open={(id) => (location.hash = `#/model/${id}`)} />
        )}
      </main>

      <footer>Models run in this browser. What you type is never sent anywhere.</footer>
    </div>
  );
}
