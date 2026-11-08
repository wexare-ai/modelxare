/**
 * The front page: what modelXare is for, before anyone tries it. Few words,
 * drawn in the weXare look (cut paper, crayon, people pink, AI navy). The
 * working app is one click away at #/try.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Minds } from './Minds.tsx';
import { Story } from './Story.tsx';
import { WexareLogo } from './WexareLogo.tsx';
import './landing.css';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Sections land like paper as they scroll into view. */
function useReveal(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const els = root.current!.querySelectorAll('[data-reveal]');
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      },
      { threshold: 0.15 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [root]);
}

/** Runs `frame` on every animation frame while `el` is on screen, never with reduced motion. */
function useFrames(el: RefObject<HTMLElement | null>, frame: (t: number) => void) {
  const latest = useRef(frame);
  latest.current = frame;
  useEffect(() => {
    if (reducedMotion()) {
      latest.current(0);
      return;
    }
    let raf = 0;
    let visible = false;
    const start = performance.now();
    const tick = (now: number) => {
      raf = 0;
      if (!visible) return;
      latest.current((now - start) / 1000);
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(tick);
    });
    io.observe(el.current!);
    latest.current(0);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [el]);
}

const TASKS = [
  { verb: 'Summarize', sheet: 'var(--sunl)' },
  { verb: 'Sort', sheet: 'var(--pinkl)' },
  { verb: 'Write', sheet: 'var(--sky)' },
  { verb: 'Translate', sheet: 'var(--white)' },
  { verb: 'Reply', sheet: 'var(--skyline)' },
  { verb: 'Answer', sheet: 'var(--sunl)' },
  { verb: 'Explain', sheet: 'var(--pinkl)' },
];

/** Your laptop, with small models circling it, each good at one thing. */
function Orbit() {
  const box = useRef<HTMLDivElement>(null);
  useFrames(box, (t) => {
    const el = box.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const tiles = el.querySelectorAll<HTMLElement>('.l-tile');
    tiles.forEach((tile, i) => {
      const a = t * 0.2 + (i * 2 * Math.PI) / tiles.length + 0.4;
      const depth = (Math.sin(a) + 1) / 2;
      const x = Math.cos(a) * w * 0.43;
      const y = Math.sin(a) * h * 0.34 + h * 0.03;
      tile.style.transform = `translate(-50%, -50%) translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) scale(${(0.74 + 0.36 * depth).toFixed(3)}) rotate(${(Math.cos(a) * 5).toFixed(2)}deg)`;
      tile.style.zIndex = depth > 0.45 ? '3' : '1';
      tile.style.opacity = (0.5 + 0.5 * depth).toFixed(3);
    });
  });
  return (
    <div className="l-orbit" ref={box} aria-hidden="true">
      <svg className="l-laptop" viewBox="0 0 320 236">
        <g filter="url(#wx-crayon)">
          <rect x="34" y="8" width="252" height="172" rx="16" style={{ fill: 'var(--leaf)' }} />
          <rect x="50" y="24" width="220" height="140" rx="6" style={{ fill: 'var(--sky)' }} />
          <path d="M6 190 H314 L298 224 H22 Z" style={{ fill: 'var(--navy)' }} />
        </g>
        <g className="l-beat">
          <WexareLogo x="114" y="44" width="92" height="92" />
        </g>
      </svg>
      {TASKS.map((t) => (
        <span key={t.verb} className="l-tile" style={{ '--sheet': t.sheet } as CSSProperties}>
          {t.verb}
        </span>
      ))}
    </div>
  );
}

function Hero() {
  return (
    <section className="l-hero">
      <div className="l-hero-text">
        <span className="l-tag">Decentralized AI</span>
        <h1 className="l-title">
          AI, back in your <em className="accent">hands</em>.
        </h1>
        <p className="l-lede">Small AI models that run on your own laptop. Shared by people, owned by no lab.</p>
        <div className="l-ctas">
          <a className="primary" href="#/try">
            Try modelXare
          </a>
          <a className="pill-yellow" href="#/xare">
            Xare your model <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
      <Orbit />
      <a className="l-more" href="#why" onClick={(e) => (e.preventDefault(), document.getElementById('why')?.scrollIntoView({ behavior: 'smooth' }))}>
        See why <span aria-hidden="true">↓</span>
      </a>
    </section>
  );
}

const ink = { fill: 'none', stroke: 'var(--navy)', strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const KEEPS: { title: string; line: string; sheet: string; turn: string; icon: ReactNode }[] = [
  {
    title: 'Your data',
    line: 'Never uploaded.',
    sheet: 'var(--white)',
    turn: '-1.5deg',
    icon: (
      <>
        <rect x="8" y="16" width="50" height="62" rx="4" transform="rotate(-8 33 47)" style={{ fill: 'var(--skyline)' }} />
        <rect x="24" y="8" width="50" height="64" rx="4" style={{ fill: 'var(--sky)' }} />
        <path d="M34 24 H64 M34 36 H60 M34 48 H64 M34 60 H52" style={{ ...ink, strokeWidth: 4 }} />
      </>
    ),
  },
  {
    title: 'Your ideas',
    line: 'Nobody trains on them.',
    sheet: 'var(--sunl)',
    turn: '1deg',
    icon: (
      <>
        <circle cx="42" cy="34" r="24" style={{ fill: 'var(--yellow)' }} />
        <rect x="32" y="56" width="20" height="16" rx="3" style={{ fill: 'var(--navy)' }} />
        <path d="M42 46 V34 M36 30 L42 34 L48 30" style={{ ...ink, strokeWidth: 3.5 }} />
        <path d="M8 30 H2 M42 4 V-2 M76 30 H82 M18 8 L14 4 M66 8 L70 4" style={{ ...ink, stroke: 'var(--sun)', strokeWidth: 4 }} />
      </>
    ),
  },
  {
    title: 'Your know-how',
    line: 'Taught to a model you own.',
    sheet: 'var(--sky)',
    turn: '-0.5deg',
    icon: (
      <>
        <path d="M42 18 C 30 10, 14 10, 4 14 V70 C 14 66, 30 66, 42 74 Z" style={{ fill: 'var(--white)' }} />
        <path d="M42 18 C 54 10, 70 10, 80 14 V70 C 70 66, 54 66, 42 74 Z" style={{ fill: 'var(--skyline)' }} />
        <path d="M42 18 V74" style={{ ...ink, stroke: 'var(--leaf)', strokeWidth: 5 }} />
        <path d="M14 30 H32 M14 42 H32 M52 30 H70 M52 42 H66" style={{ ...ink, strokeWidth: 3.5 }} />
      </>
    ),
  },
  {
    title: 'Your edge',
    line: 'Your alpha stays private.',
    sheet: 'var(--pinkl)',
    turn: '1.5deg',
    icon: (
      <>
        <path d="M6 72 H80 M6 72 V8" style={{ ...ink, strokeWidth: 4 }} />
        <path d="M14 60 L32 44 L44 52 L72 20" style={{ ...ink, stroke: 'var(--pink)', strokeWidth: 7 }} />
        <path d="M58 18 H74 V34" style={{ ...ink, stroke: 'var(--pink)', strokeWidth: 7 }} />
      </>
    ),
  },
];

/** A small pink heart: this stays with its person. */
const KEPT = 'M12 21 C 5 15, 1 11, 1 7 A 5 5 0 0 1 12 5 A 5 5 0 0 1 23 7 C 23 11, 19 15, 12 21 Z';

function Yours() {
  return (
    <section className="l-section">
      <h2 className="l-h2" data-reveal>
        What’s yours stays <em className="accent">yours</em>.
      </h2>
      <p className="l-sub" data-reveal style={{ '--i': 1 } as CSSProperties}>
        The model comes to your data, not the other way around.
      </p>
      <ul className="l-keeps">
        {KEEPS.map((k, i) => (
          <li key={k.title} className="l-keep" data-reveal style={{ '--sheet': k.sheet, '--turn': k.turn, '--i': i + 1 } as CSSProperties}>
            <svg className="l-keep-icon" viewBox="-4 -6 92 90" aria-hidden="true">
              <g filter="url(#wx-crayon)">{k.icon}</g>
            </svg>
            <svg className="l-kept" viewBox="0 0 24 24" aria-hidden="true">
              <path d={KEPT} />
            </svg>
            <h3>{k.title}</h3>
            <p>{k.line}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

const SHEETS = ['var(--white)', 'var(--sky)', 'var(--sunl)', 'var(--pinkl)', 'var(--skyline)'];
const BRICKS = [
  'Summarize news',
  'Sort tickets',
  'Translate menus',
  'Bedtime stories',
  'Draft replies',
  'Fix grammar',
  'Spot spam',
  'Tag recipes',
  'Explain code',
  'Find dates',
  'Meeting notes',
  'Plain-English contracts',
  'Shakespeare style',
  'Product tags',
  'Rhymes',
  'Mood check',
  'Invoice reader',
  'Math steps',
  'Kind replies',
  'Chess hints',
  'Name ideas',
  'Lesson plans',
  'Plant care',
  'Your next model',
];

/** The catalog everyone builds: bricks land one by one, and now and then one gets picked up again. */
function Together() {
  const wall = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (reducedMotion()) return;
    let i = 0;
    const id = setInterval(() => {
      const bricks = wall.current?.querySelectorAll('.l-brick:not(.yours)');
      if (!bricks?.length) return;
      bricks.forEach((b) => b.classList.remove('reused'));
      i = (i + 7) % bricks.length;
      bricks[i]!.classList.add('reused');
    }, 1700);
    return () => clearInterval(id);
  }, []);

  return (
    <section className="l-section l-together">
      <h2 className="l-h2" data-reveal>
        One catalog, built by <em className="accent">everyone</em>.
      </h2>
      <p className="l-sub" data-reveal style={{ '--i': 1 } as CSSProperties}>
        Share one small model. Use all the others.
      </p>
      <ul className="l-wall" ref={wall}>
        {BRICKS.map((b, i) => {
          const yours = i === BRICKS.length - 1;
          return (
            <li
              key={b}
              className={yours ? 'l-brick yours' : 'l-brick'}
              data-reveal
              style={{ '--sheet': yours ? 'var(--yellow)' : SHEETS[(i * 3) % SHEETS.length], '--turn': `${((i * 37) % 7) - 3}deg`, '--i': (i * 5) % 12 } as CSSProperties}
            >
              {yours ? (
                <a href="#/xare">
                  {b} <span aria-hidden="true">↗</span>
                </a>
              ) : (
                b
              )}
              <span className="l-reuse" aria-hidden="true">
                Reused
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Finale() {
  return (
    <section className="l-final">
      <WexareLogo className="l-final-mark" data-reveal />
      <h2 className="l-h2" data-reveal style={{ '--i': 1 } as CSSProperties}>
        AI doesn’t have to belong to three labs.
        <span className="l-h2-next">
          Let’s build it <em className="accent">together</em>.
        </span>
      </h2>
      <div className="l-ctas" data-reveal style={{ '--i': 2 } as CSSProperties}>
        <a className="primary" href="#/try">
          Try modelXare
        </a>
        <a className="pill-yellow" href="#/xare">
          Xare your model <span aria-hidden="true">↗</span>
        </a>
      </div>
    </section>
  );
}

export function Landing() {
  const root = useRef<HTMLElement>(null);
  useReveal(root);
  return (
    <main className="landing" ref={root}>
      <Hero />
      <div id="why">
        <Story />
      </div>
      <Minds />
      <Yours />
      <Together />
      <Finale />
    </main>
  );
}
