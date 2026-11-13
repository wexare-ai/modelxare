import { useRef, useState } from 'react';
import { knownOutput } from '@wexare/protocol';
import type { Step } from '@wexare/router';
import { size } from './models.ts';
import { noSpaceText } from './engine.ts';
import { plainName, useAsk, useRouterModel, type Prompt } from './routing.ts';
import { labelText } from './models.ts';

const pct = (p: number) => `${Math.round(p * 100)}%`;

/** Requests the real router plans right (tests/integration/router-laya.test.ts) that models on this device can finish. */
export const EXAMPLES = [
  { label: 'Summarize and sort a message', request: 'Summarize and categorize this message: Your electricity bill of $84.20 is due on March 3. Pay online before then to avoid a late fee.' },
  { label: 'Sort a message by topic', request: 'What category is this? Your order of running shoes has shipped and will arrive on Wednesday.' },
  { label: 'Continue a story', request: 'Continue this story: Once upon a time, a little fox' },
];

export function Ask({ lede }: { lede: string }) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const ask = useAsk();
  const router = useRouterModel();
  const busy = ask.phase === 'working';
  const running = ask.steps.find((s) => s.status === 'running');

  return (
    <section className="ask-box" aria-labelledby="ask-title">
      <h1 id="ask-title" className="ask-title">
        What do you <em className="accent">need</em>?
      </h1>
      <p className="lede">{lede}</p>
      <label className="input">
        <span className="visually-hidden">Your request</span>
        <textarea
          ref={box}
          value={text}
          rows={4}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a message or say what you need, for example: Sort this message and summarize it: your flight on Friday is delayed by two hours."
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

      {!busy && (
        <div className="examples" role="group" aria-label="Examples to try">
          <span className="examples-label">Or try one:</span>
          {EXAMPLES.map((e) => (
            <button
              key={e.label}
              className="chip"
              onClick={() => {
                setText(e.request);
                box.current?.focus();
              }}
              data-testid="ask-example"
            >
              {e.label}
            </button>
          ))}
        </div>
      )}

      {ask.prompt && <PromptCard prompt={ask.prompt} respond={ask.respond} />}

      {ask.problem && (
        <div className="problem" role="alert" data-testid="ask-problem">
          <p>
            {ask.problem === 'no-router'
              ? 'The router isn’t available yet, so requests can’t be worked out automatically. Pick a model below instead.'
              : ask.problem === 'router-download'
                ? 'The router couldn’t be downloaded. Check your internet connection, then try again.'
                : ask.problem === 'no-space'
                  ? noSpaceText('the router', router.totalBytes, ask.room)
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
                  {s.decision.by === 'person'
                    ? `You chose “${s.task.title}”.`
                    : s.decision.by === 'instruction'
                      ? `“${s.decision.text}”: ${s.task.title} (${pct(s.decision.probability)} sure).`
                      : `You asked to “${s.task.title}” (${pct(s.decision.probability)} sure).`}{' '}
                  {s.route.kind === 'local'
                    ? s.decision.model?.by === 'system1'
                      ? `${s.decision.model.name} fits it best (${pct(s.decision.model.probability)} sure) and runs on this device.`
                      : 'A model on this device can do that.'
                    : s.route.kind === 'remote'
                      ? 'No model on this device can do that, so online help was used.'
                      : 'No model on this device can do that.'}
                  {s.decision.insteadOf && ` ${ask.result!.tasks.find((t) => t.id === s.decision.insteadOf)?.title ?? s.decision.insteadOf} came first, but its model answered that this is outside what it does.`}
                </li>
              ))}
              <li>
                {ask.result.ended === 'step-limit'
                  ? 'You asked for more than one request may do, so only the first steps ran.'
                  : ask.result.ended === 'unsure'
                    ? 'It wasn’t sure what you needed, so it stopped.'
                    : 'Nothing else was asked for.'}
              </li>
            </ul>
            {ask.result.judgement && (
              <p className="hint" data-testid="judgement">
                Read on this device by the router in {Math.max(1, Math.round(ask.result.judgement.latencyMs))} ms:{' '}
                {ask.result.judgement.readings
                  .map(
                    (r) =>
                      `“${r.text.length > 60 ? `${r.text.slice(0, 60)}…` : r.text}” looked like ` +
                      Object.entries(r.probabilities)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 2)
                        .map(([id, p]) => `${ask.result!.tasks.find((t) => t.id === id)?.title ?? id} ${pct(p)}`)
                        .join(', '),
                  )
                  .join('; ')}
                .
              </p>
            )}
          </details>
        </>
      )}
    </section>
  );
}

function PromptCard({ prompt, respond }: { prompt: Prompt; respond: (v: unknown) => void }) {
  return (
    <div className="clarify" role="dialog" aria-label="What do you need?" data-testid="clarify">
      <p>Which of these do you need?</p>
      <div className="choices">
        {prompt.options.map((o) => (
          <button key={o.id} className="chip" onClick={() => respond(o.id)}>
            {o.title}
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
  const title = step.task.title;
  // A release can say its answers are code or command lines: they show as code.
  const op = step.route.kind === 'local' ? step.route.release.manifest.operations.find((o) => o.id === step.task.id) : undefined;
  const out = op && knownOutput(op);
  const code = out?.type === 'text' && !!out.code;
  const [copied, setCopied] = useState(false);
  const value = step.output?.label ? labelText(step.output.label) : step.output?.text;
  const by =
    step.route.kind === 'local'
      ? `By ${plainName(step.route.release.name)}, on this device.`
      : step.route.kind === 'remote'
        ? `By ${step.route.model} through ${step.route.provider}. Your text was sent to ${step.route.provider}.`
        : `No model on this device can ${title[0]!.toLowerCase()}${title.slice(1)} yet. To use your own online AI for steps like this, turn on online help in Settings.`;
  return (
    <li className={`step ${step.status}`} data-testid="step" data-task={step.task.id} data-route={step.route.kind} data-status={step.status}>
      <h2 className="tag">{title}</h2>
      {step.status === 'waiting' && <p className="muted">Next.</p>}
      {step.status === 'running' && <p className="pending-text">{partial || 'Working…'}</p>}
      {step.status === 'done' &&
        (step.output?.label ? (
          <p className="topic">{labelText(step.output.label)}</p>
        ) : code ? (
          <pre className="step-command">
            <code>{step.output?.text}</code>
          </pre>
        ) : (
          <p>{step.output?.text}</p>
        ))}
      {step.status === 'done' && code && <p className="hint">Small models get commands wrong sometimes. Read it before you run it.</p>}
      {(step.status === 'failed' || (step.status === 'unavailable' && step.route.kind === 'local')) && <p className="failed">{step.error}</p>}
      {/* Which model does a step is settled when it starts. */}
      {step.status !== 'waiting' && <p className="byline">{by}</p>}
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
