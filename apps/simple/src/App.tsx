import { useEffect, useState } from 'react';
import { Analytics, type BeforeSend } from '@vercel/analytics/react';
import { remoteHelp } from '@wexare/router';
import { BrandDefs } from './Brand.tsx';
import { useConnection, useStorage } from './engine.ts';
import { Home } from './Home.tsx';
import { Landing } from './Landing.tsx';
import { ModelPage } from './ModelPage.tsx';
import { Settings } from './Settings.tsx';
import type { TaskId } from './models.ts';
import { useOnlineHelp } from './routing.ts';
import { WexareLogo } from './WexareLogo.tsx';
import { Train } from './Train.tsx';
import { Xare } from './Xare.tsx';

const modelInHash = () => /^#\/model\/([0-9a-f]{64})$/.exec(location.hash)?.[1] ?? null;
const settingsInHash = () => location.hash === '#/settings';
const xareInHash = () => location.hash === '#/xare';
const trainInHash = () => location.hash === '#/xare/train';
/** The working app: the Ask box and every model. The front page (#/) says what modelXare is for. */
const tryInHash = () => location.hash === '#/try';
const landingInHash = () => !modelInHash() && !settingsInHash() && !xareInHash() && !trainInHash() && !tryInHash();

/**
 * The page for Vercel Analytics. The app routes by hash, which the analytics
 * script doesn't see, so each screen is reported as a path of its own. Only
 * these fixed paths and a model's release ID are sent, never what people type.
 */
const pageInHash = (): { route: string; path: string } => {
  const id = modelInHash();
  if (id) return { route: '/model/[id]', path: `/model/${id}` };
  const path = settingsInHash() ? '/settings' : xareInHash() ? '/xare' : trainInHash() ? '/xare/train' : tryInHash() ? '/try' : '/';
  return { route: path, path };
};

/** Report the URL without its hash: the path above already says which screen it is. */
const withoutHash: BeforeSend = (event) => ({ ...event, url: event.url.split('#')[0]! });

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
  const [xare, setXare] = useState(xareInHash);
  const [train, setTrain] = useState(trainInHash);
  const [landing, setLanding] = useState(landingInHash);
  const [page, setPage] = useState(pageInHash);
  const help = remoteHelp(useOnlineHelp());
  const [task, setTask] = useState<TaskId | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onHash = () => {
      setModelId(modelInHash());
      setSettings(settingsInHash());
      setXare(xareInHash());
      setTrain(trainInHash());
      setLanding(landingInHash());
      setPage(pageInHash());
      scrollTo(0, 0);
    };
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  if (steppedAside && !landing) {
    return (
      <div className="app">
        <BrandDefs />
        <main className="aside">
          <WexareLogo className="aside-mark" />
          <h1>modelXare is open in another tab</h1>
          <p>It works in one tab at a time.</p>
          <button className="primary" onClick={() => location.reload()}>
            Use it here
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="app">
      <Analytics route={page.route} path={page.path} beforeSend={withoutHash} />
      <BrandDefs />
      <header className="nav">
        <a className="brand" href="#/">
          <WexareLogo className="brand-mark" />
          <span className="brand-name">
            <span className="brand-word">modelXare</span>
            <span className="brand-by">
              by <b>weXare</b>
            </span>
          </span>
        </a>
        {landing ? (
          <span className="nav-right">
            <a className="nav-link nav-hide-small" href="#/xare">
              Xare your model
            </a>
            <a className="pill-yellow nav-try" href="#/try">
              Try it
            </a>
          </span>
        ) : (
          <span className="nav-right">
            <span className={`connection ${connection}`}>
              <span className="connection-text">{CONNECTION[connection]}</span>
            </span>
            <a className="nav-link" href="#/settings">
              Settings
            </a>
          </span>
        )}
      </header>

      {landing ? (
        <Landing />
      ) : (
        <main className="page">
          {init && !init.persistent && (
            <div className="note" role="status">
              <p>modelXare can’t save anything in this tab right now. Close other modelXare tabs, then reload.</p>
              <button className="secondary" onClick={() => location.reload()}>
                Reload
              </button>
            </div>
          )}

          {settings ? (
            <Settings back={() => (location.hash = '#/try')} />
          ) : xare ? (
            <Xare back={() => (location.hash = '#/try')} />
          ) : train ? (
            <Train back={() => (location.hash = '#/xare')} />
          ) : modelId ? (
            <ModelPage id={modelId} preferredTask={task} back={() => (location.hash = '#/try')} />
          ) : (
            <Home task={task} setTask={setTask} query={query} setQuery={setQuery} open={(id) => (location.hash = `#/model/${id}`)} />
          )}
        </main>
      )}

      <footer className="foot">
        <WexareLogo className="foot-mark" />
        <span>
          {help
            ? `Models run in this browser. With online help on, only steps no model here can do are sent to ${help.provider}.`
            : 'Models run in this browser. What you type is never sent anywhere.'}
        </span>
      </footer>
    </div>
  );
}
