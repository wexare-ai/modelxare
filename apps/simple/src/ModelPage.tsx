import { useEffect, useRef, useState } from 'react';
import { noSpaceText, removeFromDevice, trust, useModels, useRun } from './engine.ts';
import { UNSUPPORTED_COMMAND } from '@wexare/protocol';
import { Command } from './Command.tsx';
import { TASKS, examplesFor, languageList, size, taskById, type TaskId } from './models.ts';

const DOING: Record<TaskId, string> = {
  summarization: 'Summarizing',
  'text-classification': 'Sorting',
  'text-generation': 'Writing',
  'command-generation': 'Writing the command',
};

export function ModelPage(p: { id: string; preferredTask: TaskId | null; back: () => void }) {
  const { models, loaded } = useModels();
  const model = models.find((m) => m.id === p.id);
  const run = useRun(model);
  const [chosen, setChosen] = useState<TaskId | null>(p.preferredTask);
  const [text, setText] = useState('');
  const [example, setExample] = useState(0);
  const [copied, setCopied] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), [model?.id]);

  if (!model) {
    return (
      <>
        <BackLink back={p.back} />
        <p className="empty" role="status">
          {loaded ? 'This model is no longer available here.' : 'Looking for this model…'}
        </p>
      </>
    );
  }

  const taskId = chosen && model.tasks.includes(chosen) ? chosen : model.tasks[0]!;
  const task = taskById(taskId)!;
  const busy = run.phase === 'downloading' || run.phase === 'preparing' || run.phase === 'working';
  const downloaded = model.downloadBytes < model.totalBytes;
  const publisher = trust.describe(model.release.pubkey);
  const answer = run.answer?.task === taskId ? run.answer : null;

  const tryExample = () => {
    const examples = examplesFor(task, model.name);
    setText(examples[example % examples.length]!);
    setExample((n) => n + 1);
  };
  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <BackLink back={p.back} />
      <h1 className="title" ref={heading} tabIndex={-1}>
        {model.name}
      </h1>
      <p className="desc">{model.description}</p>
      <p className="langs">Works with {languageList(model.languages)}.</p>

      {model.tasks.length > 1 && (
        <div className="switch" role="group" aria-label="Task">
          {model.tasks.map((t) => (
            <button key={t} aria-pressed={t === taskId} disabled={busy} onClick={() => setChosen(t)}>
              {taskById(t)!.verb}
            </button>
          ))}
        </div>
      )}

      <label className="input">
        <span className="visually-hidden">Your text</span>
        <textarea value={text} placeholder={task.placeholder} rows={5} disabled={busy} onChange={(e) => setText(e.target.value)} data-testid="input" />
      </label>
      <button className="link" onClick={tryExample} disabled={busy}>
        Try an example
      </button>

      <div className="actions">
        {busy ? (
          <>
            <div className="progress" role="status" aria-live="polite">
              <span>
                {run.phase === 'downloading' ? `Downloading ${Math.floor(run.progress * 100)}%` : run.phase === 'preparing' ? 'Getting the model ready' : DOING[taskId]}
              </span>
              <span className={run.phase === 'downloading' ? 'bar' : 'bar waiting'}>
                <span style={run.phase === 'downloading' ? { width: `${Math.max(2, run.progress * 100)}%` } : undefined} />
              </span>
            </div>
            <button className="secondary" onClick={run.stop}>
              {run.phase === 'downloading' ? 'Cancel download' : 'Stop'}
            </button>
          </>
        ) : (
          <>
            <button className="primary" disabled={!text.trim()} onClick={() => run.run(taskId, text.trim())} data-testid="run">
              {task.action}
            </button>
            {run.missingBytes > 0 && <span className="hint">The first time, this downloads {size(run.missingBytes)}.</span>}
          </>
        )}
      </div>

      {run.phase === 'working' && run.partial && (
        <section className="answer pending" aria-live="polite">
          <h2 className="tag">{task.result}</h2>
          <p>{run.partial}</p>
        </section>
      )}

      {answer && taskId === 'command-generation' && (
        <section className="answer" data-testid="answer">
          <h2 className="tag">{task.result}</h2>
          {answer.text === UNSUPPORTED_COMMAND ? (
            <p>This tool can’t do that. Try asking another way.</p>
          ) : (
            <>
              <Command text={answer.text!} />
              <p className="hint">Small models get commands wrong sometimes. Read it before you run it.</p>
            </>
          )}
        </section>
      )}

      {answer && taskId !== 'command-generation' && (
        <section className="answer" data-testid="answer">
          <h2 className="tag">{task.result}</h2>
          {answer.topic ? (
            <p className="topic">{answer.topic}</p>
          ) : taskId === 'text-generation' ? (
            <p>
              <span className="prompt">{answer.input}</span> {answer.text}
            </p>
          ) : (
            <p>{answer.text}</p>
          )}
          <button className="link" onClick={() => copy(answer.topic ?? (taskId === 'text-generation' ? `${answer.input} ${answer.text}` : answer.text!))}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </section>
      )}

      {run.phase === 'failed' && (
        <div className="problem" role="alert">
          <p>
            {run.problem === 'download'
              ? 'The model couldn’t be downloaded. Check your internet connection, then try again.'
              : run.problem === 'space' && run.space
                ? noSpaceText('this model', run.space.bytes, run.space.room)
                : 'The model didn’t give a usable answer. Try again, or reword your text.'}
          </p>
          <button className="secondary" onClick={() => run.run(taskId, text.trim())} disabled={!text.trim()}>
            Try again
          </button>
        </div>
      )}

      <details className="about">
        <summary>About this model</summary>
        <dl>
          <dt>What it does</dt>
          <dd>{model.tasks.map((t) => TASKS.find((x) => x.id === t)!.verb).join(', ')}</dd>
          <dt>Size</dt>
          <dd>
            {size(model.totalBytes)}, {model.downloadBytes === 0 ? 'saved on this device' : downloaded ? 'partly saved on this device' : 'not downloaded yet'}
          </dd>
          <dt>License</dt>
          <dd>{model.license}</dd>
          {publisher && (
            <>
              <dt>Published by</dt>
              <dd>{publisher}</dd>
            </>
          )}
          <dt>Checked</dt>
          <dd>Before it runs, this device checks the model is exactly what its publisher released.</dd>
        </dl>
        {downloaded && !busy && (
          <button className="secondary" onClick={() => void removeFromDevice(model).then(run.reset)}>
            Remove from this device
          </button>
        )}
      </details>
    </>
  );
}

function BackLink({ back }: { back: () => void }) {
  return (
    <button className="back" onClick={back}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      All models
    </button>
  );
}
