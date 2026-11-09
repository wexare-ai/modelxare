/**
 * The front page's System 1 + System 2 section: one request, played in a
 * browser tab. The System 1 model (Laya) splits it and decides what each part
 * asks for; System 2 language models from the catalog do the work.
 *
 * Everything shown is what the real models did with this request
 * (docs/acceptance.md, "Everyday examples"): the router read "Categorize" as
 * sort 0.99 and "summarize this message" as summarize 0.99; Qwen2.5 0.5B
 * sorted the message as Travel and SmolLM2 360M wrote the summary.
 */
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';

const REQUEST = 'Categorize and summarize this message: Hi Sam, because of a storm your flight to Lisbon on Friday will leave two hours late, at 16:40. Your seat and bags stay the same.';

const PARTS = [
  { text: 'Categorize', intent: 'Sort', score: '0.99', width: 99, model: 0 },
  { text: 'summarize this message', intent: 'Summarize', score: '0.99', width: 99, model: 1 },
];

const MODELS = [
  { verb: 'Sort', name: 'Qwen2.5 0.5B', result: 'Travel', sheet: 'var(--pinkl)' },
  { verb: 'Summarize', name: 'SmolLM2 360M', result: 'Your flight to Lisbon on Friday will leave two hours late at 16:40. Your seat and bags stay the same.', sheet: 'var(--sunl)' },
  { verb: 'Write', name: 'Stories 15M', result: '', sheet: 'var(--sky)' },
];

/** How long each step lasts, in ms: empty, typing, split, into System 1, decided, sent, working, answered. */
const STEPS = [600, 1800, 1000, 800, 1400, 900, 1600, 4600];
const LAST = STEPS.length - 1;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Plays the steps in a loop while the section is on screen; without motion, shows the end. */
function useSteps(el: RefObject<HTMLElement | null>) {
  const [step, setStep] = useState(() => (reducedMotion() ? LAST : 0));
  const [typed, setTyped] = useState(() => (reducedMotion() ? REQUEST.length : 0));
  useEffect(() => {
    if (reducedMotion()) return;
    let timer = 0;
    let typing = 0;
    let s = 0;
    let visible = false;
    const run = () => {
      clearTimeout(timer);
      clearInterval(typing);
      setStep(s);
      if (s === 0) setTyped(0);
      if (s === 1) {
        const started = performance.now();
        typing = window.setInterval(() => {
          const n = Math.min(REQUEST.length, Math.round(((performance.now() - started) / (STEPS[1]! - 200)) * REQUEST.length));
          setTyped(n);
          if (n >= REQUEST.length) clearInterval(typing);
        }, 30);
      }
      if (s >= 2) setTyped(REQUEST.length);
      timer = window.setTimeout(() => {
        s = (s + 1) % STEPS.length;
        if (visible) run();
      }, STEPS[s]);
    };
    const io = new IntersectionObserver(([e]) => {
      const was = visible;
      visible = !!e?.isIntersecting;
      if (visible && !was) run();
      if (!visible) {
        clearTimeout(timer);
        clearInterval(typing);
      }
    }, { threshold: 0.35 });
    io.observe(el.current!);
    return () => {
      io.disconnect();
      clearTimeout(timer);
      clearInterval(typing);
    };
  }, [el]);
  return { step, typed };
}

function Arrow({ on }: { on: boolean }) {
  return (
    <svg className={on ? 'l-arrow on' : 'l-arrow'} viewBox="0 0 64 32" aria-hidden="true">
      <g filter="url(#wx-crayon)">
        <path d="M4 16 H52" style={{ fill: 'none', strokeWidth: 6, strokeLinecap: 'round' }} />
        <path d="M40 4 L58 16 L40 28" style={{ fill: 'none', strokeWidth: 6, strokeLinecap: 'round', strokeLinejoin: 'round' }} />
      </g>
    </svg>
  );
}

const AI_HEART = 'M50 80 L10 40 L31 19 L50 38 L69 19 L90 40 Z';

export function Minds() {
  const frame = useRef<HTMLDivElement>(null);
  const { step, typed } = useSteps(frame);

  return (
    <section className="l-section l-minds" aria-labelledby="minds-title">
      <span className="l-tag" data-reveal>
        System 1 + System 2
      </span>
      <h2 id="minds-title" className="l-h2" data-reveal style={{ '--i': 1 } as CSSProperties}>
        Thinks fast, works deep, right in your <em className="accent">browser</em>.
      </h2>
      <p className="l-sub" data-reveal style={{ '--i': 2 } as CSSProperties}>
        A fast System 1 model decides what’s needed. System 2 language models do the work. No server, no lab.
      </p>

      <div className="l-browser" ref={frame} data-reveal style={{ '--i': 3 } as CSSProperties}>
        <div className="l-browser-bar" aria-hidden="true">
          <i />
          <i />
          <i />
          <span>modelXare, in this tab</span>
        </div>

        <div className="l-flow">
          <div className="l-col">
            <header>
              <span className="l-tag human">You</span>
              <span className="l-note">ask in plain words</span>
            </header>
            <p className="l-request">
              <span className="l-ghost" aria-hidden="true">
                {REQUEST}
              </span>
              <span className="l-typed">
                <span className="visually-hidden">{REQUEST}</span>
                <span aria-hidden="true">{REQUEST.slice(0, typed)}</span>
                {step === 1 && <span className="l-caret" aria-hidden="true" />}
              </span>
            </p>
            <ul className="l-parts" aria-label="The parts System 1 reads">
              {PARTS.map((p) => (
                <li key={p.text} className={step >= 2 ? 'on' : undefined}>
                  “{p.text}”
                </li>
              ))}
            </ul>
          </div>

          <Arrow on={step >= 3} />

          <div className={`l-col l-s1${step === 3 ? ' thinking' : ''}`}>
            <header>
              <span className="l-tag">System 1</span>
              <span className="l-note">fast: decides</span>
            </header>
            <div className="l-s1-box">
              <div className="l-s1-name">
                <svg viewBox="0 0 100 100" aria-hidden="true">
                  <path d={AI_HEART} />
                </svg>
                <span>
                  <strong>Laya</strong> decision model
                </span>
              </div>
              {PARTS.map((p) => (
                <div key={p.text} className={step >= 4 ? 'l-verdict on' : 'l-verdict'}>
                  <span className="l-verdict-part">“{p.text}”</span>
                  <span className="l-bar" aria-hidden="true">
                    <span style={{ width: step >= 4 ? `${p.width}%` : '0%' }} />
                  </span>
                  <span className="l-verdict-out">
                    {p.intent} <b>{p.score}</b>
                  </span>
                </div>
              ))}
            </div>
          </div>

          <Arrow on={step >= 5} />

          <div className="l-col l-s2">
            <header>
              <span className="l-tag">System 2</span>
              <span className="l-note">deep: does the work</span>
            </header>
            <ul className="l-models">
              {MODELS.map((m, i) => {
                const used = PARTS.some((p) => p.model === i);
                const state = step < 5 ? '' : !used ? 'idle' : step >= LAST ? 'done' : 'working';
                return (
                  <li key={m.verb} className={`l-model ${state}`} style={{ '--sheet': m.sheet } as CSSProperties}>
                    <span className="l-model-head">
                      <strong>{m.verb}</strong>
                      <small>{m.name}</small>
                    </span>
                    {used && (
                      <span className="l-model-out">
                        {state === 'working' && <span className="l-dots" aria-hidden="true" />}
                        <span className="l-result">{m.result}</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>

        <p className="l-browser-foot">Every model here runs in this browser tab. Each comes from the open catalog and is checked before it runs.</p>
      </div>
    </section>
  );
}
