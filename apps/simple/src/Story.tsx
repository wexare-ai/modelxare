/**
 * The landing page's before and after, played by scrolling: a few labs'
 * data centers pull everyone's data in, then break into small models that
 * land on everyone's own laptop, and people start passing models (never
 * data) to each other.
 *
 * Three stacked SVGs share one viewBox, so the crayon filter (expensive)
 * only runs on what changes slowly: the people and laptops never move, the
 * towers only change with scroll, and everything that moves every frame is
 * drawn unfiltered in its own layer.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';

const AI_HEART = 'M50 80 L10 40 L31 19 L50 38 L69 19 L90 40 Z';

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const ramp = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const ease = (x: number) => x * x * (3 - 2 * x);
const frac = (x: number) => x - Math.floor(x);
const lerp = (a: number, b: number, s: number) => a + (b - a) * s;
const noise = (k: number) => frac(Math.sin(k * 12.9898) * 43758.5453);

interface Tower {
  x: number;
  w: number;
  h: number;
}
interface Geo {
  W: number;
  H: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  n: number;
  base: number;
  towers: Tower[];
}

const WIDE: Geo = {
  W: 1000,
  H: 600,
  cx: 500,
  cy: 300,
  rx: 425,
  ry: 228,
  n: 12,
  base: 392,
  towers: [
    { x: 422, w: 66, h: 168 },
    { x: 500, w: 88, h: 236 },
    { x: 578, w: 66, h: 146 },
  ],
};

const TALL: Geo = {
  W: 600,
  H: 760,
  cx: 300,
  cy: 380,
  rx: 238,
  ry: 318,
  n: 10,
  base: 470,
  towers: [
    { x: 236, w: 56, h: 150 },
    { x: 300, w: 72, h: 214 },
    { x: 364, w: 56, h: 128 },
  ],
};

interface Pt {
  x: number;
  y: number;
}

function layout(g: Geo) {
  const devices: Pt[] = Array.from({ length: g.n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / g.n + Math.PI / g.n;
    return { x: g.cx + g.rx * Math.cos(a), y: g.cy + g.ry * Math.sin(a) };
  });
  const edges: [number, number][] = [];
  for (let i = 0; i < g.n; i++) edges.push([i, (i + 1) % g.n]);
  for (let i = 0; i + 3 <= g.n; i += 4) edges.push([i, (i + 3) % g.n]);
  const windows = g.towers.map((t) => {
    const cols = Math.floor((t.w - 8) / 15);
    const rows = Math.floor((t.h - 22) / 17);
    const left = t.x - ((cols - 1) * 15) / 2;
    const out: Pt[] = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: left + c * 15, y: g.base - t.h + 18 + r * 17 });
    return out;
  });
  // Where each person's data goes: the tower nearest to them, about two thirds up.
  const targets = devices.map((d) => {
    const t = g.towers.reduce((best, t) => (Math.abs(t.x - d.x) < Math.abs(best.x - d.x) ? t : best));
    return { x: t.x, y: g.base - t.h * 0.62 };
  });
  return { devices, edges, windows, targets };
}
type Layout = ReturnType<typeof layout>;

/** A point `gap` units from `a` toward `b`: lines start at a laptop's edge, not under it. */
function toward(a: Pt, b: Pt, gap: number): Pt {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: a.x + ((b.x - a.x) * gap) / d, y: a.y + ((b.y - a.y) * gap) / d };
}

/** Tower scale: they grow while data pours in, then fall apart. */
function towerState(p: number, t: number) {
  const grow = 1 + 0.1 * ease(ramp(p, 0.12, 0.38));
  const fall = ease(ramp(p, 0.44, 0.56));
  const shake = p > 0.38 && p < 0.5 ? Math.sin(t * 52) * 2.4 * ramp(p, 0.38, 0.42) : 0;
  return { scale: grow * (1 - fall), fall, shake };
}

/** A small model in flight: the AI heart, outlined in paper so it reads over lines. */
const MODEL = { fill: 'var(--navy)', stroke: 'var(--paper)', strokeWidth: 12, strokeLinejoin: 'round', paintOrder: 'stroke' } as const;

const towerTransform = (g: Geo, tw: Tower, scale: number, shake: number) =>
  `translate(${tw.x + shake} ${g.base}) scale(${scale}) translate(${-tw.x} ${-g.base})`;

/** People behind their laptops. Drawn once, through the crayon filter. */
const People = memo(function People({ g, L }: { g: Geo; L: Layout }) {
  return (
    <svg className="l-layer" viewBox={`0 0 ${g.W} ${g.H}`} aria-hidden="true">
      <g filter="url(#wx-crayon)">
        {L.devices.map((d, i) => (
          <g key={i} transform={`translate(${d.x} ${d.y})`}>
            <circle cx="0" cy="-33" r="11" style={{ fill: 'var(--pink)' }} />
            <path d="M-21 -4 C -21 -26, 21 -26, 21 -4 Z" style={{ fill: 'var(--pink)' }} />
            <rect x="-27" y="-13" width="54" height="36" rx="5" style={{ fill: 'var(--leaf)' }} />
            <rect x="-22" y="-8" width="44" height="26" rx="2" style={{ fill: 'var(--sky)' }} />
            <path d="M-34 25 H34 L29 33 H-29 Z" style={{ fill: 'var(--navy)' }} />
          </g>
        ))}
      </g>
    </svg>
  );
});

/** The labs' buildings. They only change with scrolling, so the filter rarely reruns. */
const Towers = memo(function Towers({ g, scale, shake }: { g: Geo; scale: number; shake: number }) {
  if (scale < 0.01) return <svg className="l-layer l-towers" viewBox={`0 0 ${g.W} ${g.H}`} aria-hidden="true" />;
  return (
    <svg className="l-layer l-towers" viewBox={`0 0 ${g.W} ${g.H}`} aria-hidden="true">
      <g filter="url(#wx-crayon)" opacity={clamp(scale * 1.4)}>
        {g.towers.map((tw, i) => (
          <g key={i} transform={towerTransform(g, tw, scale, shake)}>
            <rect x={tw.x - tw.w / 2} y={g.base - tw.h} width={tw.w} height={tw.h} rx="3" style={{ fill: 'var(--navy)' }} />
            <rect x={tw.x - 3} y={g.base - tw.h - 26} width="6" height="28" style={{ fill: 'var(--navy)' }} />
          </g>
        ))}
        <path d={`M${g.towers[0]!.x - 90} ${g.base + 4} H${g.towers[2]!.x + 90}`} style={{ stroke: 'var(--navy)', strokeWidth: 6, strokeLinecap: 'round' }} />
      </g>
    </svg>
  );
});

/** Everything that moves every frame, without the filter. */
function Live({ g, L, p, t }: { g: Geo; L: Layout; p: number; t: number }) {
  const { scale, shake } = towerState(p, t);
  const lines = ramp(p, 0.02, 0.1) * (1 - ramp(p, 0.4, 0.48));
  const flow = ramp(p, 0.12, 0.18) * (1 - ramp(p, 0.38, 0.44));
  const home = ramp(p, 0.58, 0.64);
  const share = ramp(p, 0.8, 0.86);
  const lit = 0.3 + 0.55 * flow;

  return (
    <svg className="l-layer l-live" viewBox={`0 0 ${g.W} ${g.H}`} aria-hidden="true">
      {/* People connected to each other, drawn in one by one. */}
      <g style={{ stroke: 'var(--leaf)', strokeWidth: 3, strokeLinecap: 'round', fill: 'none' }}>
        {L.edges.map(([a, b], e) => {
          const d = ease(ramp(p, 0.72 + e * 0.005, 0.8 + e * 0.005));
          if (d <= 0) return null;
          const from = toward(L.devices[a]!, L.devices[b]!, 46);
          const to = toward(L.devices[b]!, L.devices[a]!, 46);
          return <path key={e} d={`M${from.x} ${from.y} L${to.x} ${to.y}`} pathLength={1} strokeDasharray="1 1" strokeDashoffset={1 - d} opacity={0.6} />;
        })}
      </g>

      {/* Everyone wired to the labs. */}
      {lines > 0 && (
        <g opacity={lines} style={{ stroke: 'var(--navy)', strokeWidth: 2, strokeDasharray: '3 7', strokeLinecap: 'round', fill: 'none' }}>
          {L.devices.map((d, i) => {
            const from = toward(d, L.targets[i]!, 44);
            return <path key={i} d={`M${from.x} ${from.y} L${L.targets[i]!.x} ${L.targets[i]!.y}`} opacity={0.45} />;
          })}
        </g>
      )}

      {/* The labs' lights, busier while data pours in. */}
      {scale > 0.01 &&
        g.towers.map((tw, k) => (
          <g key={k} transform={towerTransform(g, tw, scale, shake)} opacity={clamp(scale * 1.4)}>
            {L.windows[k]!.map((w, j) => {
              const on = noise(k * 97 + j + Math.floor(t * 1.6 + noise(j + k) * 3) * 13.1) < lit;
              return <rect key={j} x={w.x - 4} y={w.y - 4} width="8" height="8" rx="1.5" style={{ fill: on ? 'var(--sun)' : 'var(--muted)' }} />;
            })}
          </g>
        ))}

      {/* Data flowing out to the labs: people's pink. */}
      {flow > 0 &&
        L.devices.map((d, i) =>
          [0, 0.5].map((k) => {
            const s = frac(t * 0.42 + noise(i) + k);
            const from = toward(d, L.targets[i]!, 44);
            const x = lerp(from.x, L.targets[i]!.x, s);
            const y = lerp(from.y, L.targets[i]!.y, s);
            return <circle key={`${i}-${k}`} cx={x} cy={y} r={6 - 2.5 * s} opacity={flow * (s < 0.1 ? s * 10 : 1)} style={{ fill: 'var(--pink)' }} />;
          }),
        )}

      {/* The labs break up into small models, one flying to each laptop. */}
      {L.devices.map((d, i) => {
        const f = ease(ramp(p, 0.44 + i * 0.007, 0.54 + i * 0.007));
        if (f <= 0 || f >= 1) return null;
        const ws = L.windows[i % g.towers.length]!;
        const s = ws[(i * 7) % ws.length]!;
        const x = lerp(s.x, d.x, f);
        const y = lerp(s.y, d.y + 5, f) - Math.sin(Math.PI * f) * 90;
        return <path key={i} d={AI_HEART} transform={`translate(${x - 16} ${y - 16}) scale(0.32) rotate(${(1 - f) * 200} 50 50)`} style={MODEL} />;
      })}

      {/* A model on every screen. */}
      {L.devices.map((d, i) => {
        const on = ramp(p, 0.535 + i * 0.007, 0.55 + i * 0.007);
        return on > 0 ? <path key={i} d={AI_HEART} transform={`translate(${d.x - 13} ${d.y - 8}) scale(0.26)`} opacity={on} style={{ fill: 'var(--navy)' }} /> : null;
      })}

      {/* Data staying home: a pink dot circling its person. */}
      {home > 0 &&
        L.devices.map((d, i) => {
          const a = t * 1.3 + i * 1.7;
          return <circle key={i} cx={d.x + Math.cos(a) * 40} cy={d.y - 8 + Math.sin(a) * 26} r="5.5" opacity={home} style={{ fill: 'var(--pink)' }} />;
        })}

      {home > 0 && (
        <text x={g.cx} y={g.cy + 8} textAnchor="middle" className="l-middle" opacity={ramp(p, 0.62, 0.7)}>
          nobody in the middle
        </text>
      )}

      {/* Models passed from person to person, each arrival a small ring. */}
      {share > 0 &&
        Array.from({ length: 7 }, (_, j) => {
          const run = t * 0.4 + j * 0.37;
          const [a, b] = L.edges[(j * 5 + Math.floor(run) * 3) % L.edges.length]!;
          const [from, to] = j % 2 ? [L.devices[a]!, L.devices[b]!] : [L.devices[b]!, L.devices[a]!];
          const s = ease(frac(run));
          const x = lerp(from.x, to.x, s);
          const y = lerp(from.y, to.y, s) - Math.sin(Math.PI * s) * 26;
          const ring = ramp(s, 0.86, 1);
          return (
            <g key={j} opacity={share}>
              <path d={AI_HEART} transform={`translate(${x - 15} ${y - 15}) scale(0.3)`} style={MODEL} />
              {ring > 0 && <circle cx={to.x} cy={to.y} r={30 + ring * 26} opacity={1 - ring} style={{ fill: 'none', stroke: 'var(--leaf)', strokeWidth: 3 }} />}
            </g>
          );
        })}
    </svg>
  );
}

function Scene({ g, p, t }: { g: Geo; p: number; t: number }) {
  const L = layoutFor(g);
  const { scale, shake } = towerState(p, t);
  return (
    <div className="l-scene">
      <Towers g={g} scale={round(scale)} shake={round(shake)} />
      <People g={g} L={L} />
      <Live g={g} L={L} p={p} t={t} />
    </div>
  );
}

const round = (v: number) => Math.round(v * 200) / 200;

const layouts = new Map<Geo, Layout>();
function layoutFor(g: Geo): Layout {
  let L = layouts.get(g);
  if (!L) layouts.set(g, (L = layout(g)));
  return L;
}

const CAPTIONS = [
  { tag: 'Today', text: 'A few labs run the world’s AI.' },
  { tag: 'Today', text: 'Your questions and your data all flow into their data centers.' },
  { tag: 'What if', text: 'AI didn’t need them?' },
  { tag: 'With modelXare', text: 'Small models run on your own laptop. Your data stays with you.' },
  { tag: 'With modelXare', text: 'People share models, never their data.' },
];
const STARTS = [0, 0.12, 0.38, 0.56, 0.76];
const phaseOf = (p: number) => STARTS.reduce((at, s, i) => (p >= s ? i : at), 0);

const RAIL = [
  { label: 'Today', from: 0, to: 0.38 },
  { label: 'What if', from: 0.38, to: 0.56 },
  { label: 'With modelXare', from: 0.56, to: 1 },
];

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function Story() {
  const section = useRef<HTMLElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ p: 0, t: 0 });
  const [g, setG] = useState<Geo>(WIDE);
  const [still] = useState(reducedMotion);

  // Tall screens get the tall layout.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return; // the still version has no stage
    const pick = () => setG(el.clientWidth / Math.max(1, el.clientHeight) < 1 ? TALL : WIDE);
    pick();
    const ro = new ResizeObserver(pick);
    ro.observe(el);
    return () => ro.disconnect();
  }, [still]);

  useEffect(() => {
    if (still) return;
    const el = section.current!;
    let raf = 0;
    let visible = false;
    const start = performance.now();
    const tick = (now: number) => {
      raf = 0;
      if (!visible) return;
      const r = el.getBoundingClientRect();
      const p = clamp(-r.top / Math.max(1, r.height - innerHeight));
      setFrame({ p, t: (now - start) / 1000 });
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [still]);

  if (still) {
    // Without motion: today and tomorrow side by side.
    return (
      <section className="l-story-still" aria-label="From a few labs to everyone">
        {[
          { p: 0.3, cap: CAPTIONS[1]! },
          { p: 1, cap: CAPTIONS[3]! },
        ].map(({ p, cap }) => (
          <figure key={p}>
            <figcaption>
              <span className={`l-tag ${cap.tag === 'With modelXare' ? 'human' : ''}`}>{cap.tag}</span>
              <span className="l-cap-text">{cap.text}</span>
            </figcaption>
            <Scene g={WIDE} p={p} t={0.6} />
          </figure>
        ))}
      </section>
    );
  }

  const phase = phaseOf(frame.p);
  return (
    <section className="l-story" ref={section} aria-label="From a few labs to everyone">
      <div className="l-stage" ref={stage}>
        <ol className="l-caps">
          {CAPTIONS.map((c, i) => (
            <li key={i} className={i === phase ? 'l-cap on' : 'l-cap'} aria-current={i === phase ? 'step' : undefined}>
              <span className={`l-tag ${c.tag === 'With modelXare' ? 'human' : ''}`}>{c.tag}</span>
              <span className="l-cap-text">{c.text}</span>
            </li>
          ))}
        </ol>
        <Scene g={g} p={frame.p} t={frame.t} />
        <div className="l-rail" aria-hidden="true">
          {RAIL.map((r) => (
            <span key={r.label} className="l-rail-part" style={{ flexGrow: r.to - r.from }}>
              <span className="l-rail-bar">
                <span style={{ width: `${ramp(frame.p, r.from, r.to) * 100}%` }} />
              </span>
              <span className="l-rail-label">{r.label}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
