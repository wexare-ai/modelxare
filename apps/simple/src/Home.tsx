import { remoteHelp } from '@wexare/router';
import { Ask } from './Ask.tsx';
import { HeroDecorations } from './Brand.tsx';
import { useConnection, useModels } from './engine.ts';
import { useOnlineHelp } from './routing.ts';
import { TASKS, languageList, size, type TaskId } from './models.ts';

export function Home(p: { task: TaskId | null; setTask: (t: TaskId | null) => void; query: string; setQuery: (q: string) => void; open: (id: string) => void }) {
  const { models, loaded } = useModels();
  const connection = useConnection();
  const online = !!remoteHelp(useOnlineHelp());
  const verbs = TASKS.map((t) => ({ t, count: models.filter((m) => m.tasks.includes(t.id)).length })).filter((v) => v.count > 0);
  const q = p.query.trim().toLowerCase();
  const shown = models.filter((m) => (!p.task || m.tasks.includes(p.task)) && (!q || `${m.name} ${m.description}`.toLowerCase().includes(q)));

  return (
    <>
      <HeroDecorations />
      <Ask lede={online ? 'Small AI models that run on this device, with online help when they can’t.' : 'Small AI models that run on this device. What you type never leaves it.'} />

      <h2 className="browse-title">Or pick a model by what it does</h2>
      <div className="verbs" role="group" aria-label="Show models by task">
        {verbs.map(({ t, count }) => (
          <button key={t.id} aria-pressed={p.task === t.id} onClick={() => p.setTask(p.task === t.id ? null : t.id)}>
            {t.verb}
            <span className="count" aria-hidden="true">
              {count}
            </span>
            <span className="visually-hidden">, {count === 1 ? '1 model' : `${count} models`}</span>
          </button>
        ))}
      </div>

      <input className="search" type="search" placeholder="Search models" aria-label="Search models" value={p.query} onChange={(e) => p.setQuery(e.target.value)} />

      {shown.length > 0 ? (
        <ul className="models" data-testid="models">
          {shown.map((m) => (
            <li key={m.id}>
              <button className="model" onClick={() => p.open(m.id)}>
                <span className="model-name">{m.name}</span>
                {m.downloadBytes > 0 ? <span className="model-status">{size(m.downloadBytes)} download</span> : <span className="model-status ready">Ready</span>}
                <span className="model-desc">{m.description}</span>
                <span className="model-langs">{languageList(m.languages)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty" role="status">
          {!loaded || (models.length === 0 && connection === 'connecting')
            ? 'Looking for models…'
            : models.length === 0
              ? 'No models found. Check your internet connection; models appear here as soon as they are found.'
              : q
                ? `No models match “${p.query.trim()}”.`
                : 'No models do this yet.'}
        </p>
      )}
    </>
  );
}
