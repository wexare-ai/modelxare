import { useState } from 'react';
import type { Step } from '@wexare/router';
import { size } from './models.ts';
import { STEP_WORDS, plainName, useAsk, useRouterModel, type Prompt } from './routing.ts';

const pct = (p: number) => `${Math.round(p * 100)}%`;
const words = (id: string) => STEP_WORDS[id] ?? { name: id, result: id, doing: 'Working' };

export function Ask() {
  const [text, setText] = useState('');
  const ask = useAsk();
  const router = useRouterModel();
  const busy = ask.phase === 'working';
  const running = ask.steps.at(-1)?.status === 'running' ? ask.steps.at(-1) : undefined;

  return (
    <section className="ask-box" aria-labelledby="ask-title">
      <h1 id="ask-title" className="ask-title">
        What do you need?
      </h1>
      <label className="input">
        <span className="visually-hidden">Your request</span>
        <textarea
          value={text}
          rows={4}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a message or say what you need, for example: Sort this message and summarize it: there is a water leak near the entrance."
          data-testid="ask-input"
        />
      </label>

      <div className="actions">
        {busy && ask.prompt ? null : busy ? (
          <>
            <div className="progress" role="status" aria-live="polite">
              <span>{ask.progress !== null ? `${ask.activity} ${Math.floor(ask.progress * 100)}%` : ask.activity}</span>
              <span className={ask.progress !== null ? 'bar' : 'bar waiting'}>
                <span style={ask.progress !== null ? { width: `${Math.max(2, ask.progress * 100)}%` } : undefined} />
              </span>
            </div>
            <button className="secondary" onClick={ask.cancel}>
              Stop
            </button>
          </>
        ) : (
          <>
            <button className="primary" disabled={!text.trim()} onClick={() => void ask.go(text.trim())} data-testid="ask-go">
              Go
            </button>
            {router.status === 'not-downloaded' && (
              <span className="hint">The first time, this downloads a {size(router.missingBytes)} router that works out which model to use.</span>
            )}
          </>
        )}
      </div>

      {ask.prompt && <PromptCard prompt={ask.prompt} respond={ask.respond} />}

      {ask.problem && (
        <div className="problem" role="alert" data-testid="ask-problem">
          <p>
            {ask.problem === 'no-router'
              ? 'The router isn’t available yet, so requests can’t be worked out automatically. Pick a model below instead.'
              : ask.problem === 'router-download'
                ? 'The router couldn’t be downloaded. Check your internet connection, then try again.'
                : ask.problem === 'no-space'
                  ? `There isn’t enough free space on this device for the router (${size(router.totalBytes)}). Free up some space, then try again.`
                  : 'The router couldn’t start on this device. It needs about 3 GB of free memory: close other tabs, then try again.'}
          </p>
        </div>
      )}

      {ask.steps.length > 0 && (
        <ol className="steps" data-testid="steps">
          {ask.steps.map((s, i) => (
            <StepCard key={i} step={s} partial={s === running ? ask.partial : ''} />
          ))}
        </ol>
      )}

      {ask.result && (
        <>
          {ask.result.steps.length === 0 && <p className="empty">Nothing to do for this request.</p>}
          <details className="about" data-testid="decisions">
            <summary>How this was decided</summary>
            <ul className="decisions">
              {ask.result.steps.map((s, i) => (
                <li key={i}>
                  {s.decision.chosenBy === 'person'
                    ? `You chose “${words(s.intent.id).name}”.`
                    : `It looked like “${words(s.intent.id).name}” (${pct(s.decision.probability)} sure).`}{' '}
                  {s.route.kind === 'local' ? 'A model on this device can do that.' : s.route.kind === 'remote' ? 'No model on this device can do that, so online help was used.' : 'No model on this device can do that.'}
                </li>
              ))}
              <li>
                {ask.result.ended === 'step-limit'
                  ? 'It stopped after the most steps one request may take.'
                  : ask.result.ended === 'unsure'
                    ? 'It wasn’t sure what you needed, so it stopped.'
                    : 'Then nothing else was needed.'}
              </li>
            </ul>
            <p className="hint">These decisions are made on this device by the router, in a fraction of a second each.</p>
          </details>
        </>
      )}
    </section>
  );
}

function PromptCard({ prompt, respond }: { prompt: Prompt; respond: (v: unknown) => void }) {
  return (
    <div className="note prompt" role="dialog" aria-label="What do you need?" data-testid="clarify">
      <p>Which of these do you need?</p>
      <div className="choices">
        {prompt.options.map((o) => (
          <button key={o.id} className="secondary" onClick={() => respond(o.id)}>
            {words(o.id).name}
          </button>
        ))}
        <button className="link" onClick={() => respond(null)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function StepCard({ step, partial }: { step: Step; partial: string }) {
  const w = words(step.intent.id);
  const [copied, setCopied] = useState(false);
  const value = step.output?.topic ?? step.output?.text;
  const by =
    step.route.kind === 'local'
      ? `By ${plainName(step.route.release.name)}, on this device.`
      : step.route.kind === 'remote'
        ? `By ${step.route.model} through ${step.route.provider}. Your text was sent to ${step.route.provider}.`
        : `No model on this device can ${w.name.toLowerCase()} yet. To use your own online AI for steps like this, turn on online help in Settings.`;
  return (
    <li className={`step ${step.status}`} data-testid="step" data-intent={step.intent.id} data-route={step.route.kind} data-status={step.status}>
      <h2>{w.result}</h2>
      {step.status === 'running' && <p className="pending-text">{partial || `${w.doing}…`}</p>}
      {step.status === 'done' && (step.output?.topic ? <p className="topic">{step.output.topic}</p> : <p>{step.output?.text}</p>)}
      {step.status === 'failed' && <p className="failed">{step.error}</p>}
      <p className="byline">{by}</p>
      {step.status === 'done' && value && (
        <button
          className="link"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </li>
  );
}
