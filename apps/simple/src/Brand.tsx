/**
 * The weXare look (STYLE.md, 2026-10 brand): the SVG filters the paper and
 * crayon effects use (the weXare site's, from wexare-mvp
 * src/pages/home/LandingDefs.tsx, unchanged), and modelXare's own crayon
 * drawings for the home page's margins, in the same style.
 */

/** Rendered once per page; styles.css refers to the filters by id. */
export function BrandDefs() {
  return (
    <svg className="defs" aria-hidden="true" focusable="false">
      <defs>
        <filter id="wx-torn" x="-4%" y="-8%" width="108%" height="116%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035 0.06" numOctaves={3} seed={11} result="w" />
          <feDisplacementMap in="SourceGraphic" in2="w" scale={9} xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="wx-crayon" x="-5%" y="-5%" width="110%" height="110%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} seed={3} result="n" />
          <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.75" result="a" />
          <feComposite in="SourceGraphic" in2="a" operator="in" result="t" />
          <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves={2} seed={8} result="w" />
          <feDisplacementMap in="t" in2="w" scale={7} xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <filter id="wx-ink" x="-2%" y="-10%" width="104%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.06" numOctaves={2} seed={5} result="w" />
          <feDisplacementMap in="SourceGraphic" in2="w" scale={2.6} />
        </filter>
        <filter id="wx-brush" filterUnits="userSpaceOnUse" x="-200" y="-200" width="4000" height="3000">
          <feTurbulence type="fractalNoise" baseFrequency="0.02 0.3" numOctaves={2} seed={2} result="w" />
          <feDisplacementMap in="SourceGraphic" in2="w" scale={5} />
        </filter>
      </defs>
    </svg>
  );
}

/** The brand's AI heart: the machine heart with straight 45° sides, 80 units wide. */
const AI_HEART = 'M50 80 L10 40 L31 19 L50 38 L69 19 L90 40 Z';

const ink = { fill: 'none', stroke: 'var(--navy)', strokeLinecap: 'round' } as const;

/** Models run here: a laptop with the AI heart on its screen. */
function Laptop() {
  return (
    <svg className="d d-laptop" viewBox="0 0 160 116">
      <g filter="url(#wx-crayon)">
        <rect x="22" y="6" width="116" height="80" rx="9" style={{ fill: 'var(--leaf)' }} />
        <rect x="31" y="15" width="98" height="62" rx="4" style={{ fill: 'var(--sky)' }} />
        <path d={AI_HEART} transform="translate(56 22) scale(0.48)" style={{ fill: 'var(--navy)' }} />
        <path d="M6 92 H154 L146 108 H14 Z" style={{ fill: 'var(--navy)' }} />
      </g>
    </svg>
  );
}

/** Write: a pencil finishing a line. */
function Pencil() {
  return (
    <svg className="d d-pencil" viewBox="0 0 210 150">
      <g filter="url(#wx-crayon)">
        <path d="M8 128 C 22 104, 34 140, 50 118 S 76 104, 86 124 S 104 132, 100 120" style={{ ...ink, stroke: 'var(--leaf)', strokeWidth: 7 }} />
        <g transform="translate(100 120) rotate(-48)">
          <path d="M0 0 L24 -10 V10 Z" style={{ fill: 'var(--sunl)' }} />
          <path d="M0 0 L8 -3.4 V3.4 Z" style={{ fill: 'var(--navy)' }} />
          <rect x="24" y="-10" width="84" height="20" style={{ fill: 'var(--yellow)' }} />
          <rect x="24" y="-3" width="84" height="6" style={{ fill: 'var(--sun)' }} />
          <rect x="108" y="-10" width="10" height="20" style={{ fill: 'var(--skyline)' }} />
          <rect x="118" y="-10" width="20" height="20" rx="5" style={{ fill: 'var(--pinkd)' }} />
        </g>
      </g>
    </svg>
  );
}

/** Summarize: a long page, and the short note it becomes. */
function Summary() {
  const lines = [86, 78, 88, 70, 84, 62];
  return (
    <svg className="d d-summary" viewBox="0 0 170 160">
      <g filter="url(#wx-crayon)">
        <g transform="rotate(-7 55 75)">
          <rect x="10" y="12" width="90" height="126" rx="5" style={{ fill: 'var(--skyline)' }} />
          {lines.map((end, i) => (
            <path key={i} d={`M24 ${34 + i * 16} H${end}`} style={{ ...ink, strokeWidth: 5 }} />
          ))}
        </g>
        <g transform="rotate(6 125 110)">
          <rect x="86" y="74" width="76" height="70" rx="4" style={{ fill: 'var(--yellow)' }} />
          <path d="M100 100 H148 M100 118 H130" style={{ ...ink, strokeWidth: 6 }} />
        </g>
      </g>
    </svg>
  );
}

/** Sort: three label tags on a string, one per topic. */
function Tags() {
  const tag = (x: number, y: number, turn: number, fill: string) => (
    <g transform={`translate(${x} ${y}) rotate(${turn})`}>
      <path d="M0 -2 V16" style={{ ...ink, strokeWidth: 3 }} />
      <path d="M-18 24 L-8 12 H8 L18 24 V86 a5 5 0 0 1 -5 5 H-13 a5 5 0 0 1 -5 -5 Z" style={{ fill }} />
      <circle cx="0" cy="24" r="4.5" style={{ fill: 'var(--paper)' }} />
      <path d="M-9 52 H9 M-9 66 H4" style={{ ...ink, strokeWidth: 4 }} />
    </g>
  );
  return (
    <svg className="d d-tags" viewBox="0 0 170 150">
      <g filter="url(#wx-crayon)">
        <path d="M6 18 C 50 34, 120 34, 164 16" style={{ ...ink, strokeWidth: 4 }} />
        {tag(30, 23, -10, 'var(--pinkd)')}
        {tag(85, 29, 5, 'var(--leaf)')}
        {tag(138, 25, -4, 'var(--sun)')}
      </g>
    </svg>
  );
}

/** The home page's margins: what this app does, drawn in crayon, never behind text. */
export function HeroDecorations() {
  return (
    <div className="deco" aria-hidden="true">
      <Laptop />
      <Pencil />
      <Summary />
      <Tags />
    </div>
  );
}
