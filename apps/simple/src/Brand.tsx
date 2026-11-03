/**
 * The weXare look (STYLE.md, 2026-10 brand): the SVG filters the paper and
 * crayon effects use, and the crayon decorations at the edges of the home
 * page. Filters and shapes are the weXare site's (wexare-mvp
 * src/pages/home/LandingDefs.tsx and Decorations.tsx), unchanged.
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

const LEAF = 'M30 200 C 3 150, -2 70, 30 0 C 62 70, 57 150, 30 200 Z';

const SUN_RAYS = [
  'M157.8,94.8 L197.0,100.0 L157.8,105.2Z',
  'M154.3,120.4 L187.4,142.1 L149.8,129.8Z',
  'M140.1,141.9 L160.5,175.8 L131.9,148.4Z',
  'M117.9,155.2 L121.6,194.6 L107.8,157.5Z',
  'M92.2,157.5 L78.4,194.6 L82.1,155.2Z',
  'M68.1,148.4 L39.5,175.8 L59.9,141.9Z',
  'M50.2,129.8 L12.6,142.1 L45.7,120.4Z',
  'M42.2,105.2 L3.0,100.0 L42.2,94.8Z',
  'M45.7,79.6 L12.6,57.9 L50.2,70.2Z',
  'M59.9,58.1 L39.5,24.2 L68.1,51.6Z',
  'M82.1,44.8 L78.4,5.4 L92.2,42.5Z',
  'M107.8,42.5 L121.6,5.4 L117.9,44.8Z',
  'M131.9,51.6 L160.5,24.2 L140.1,58.1Z',
  'M149.8,70.2 L187.4,57.9 L154.3,79.6Z',
];

function Sprig({ className, fill, angles }: { className: string; fill: string; angles: number[] }) {
  return (
    <svg className={`d ${className}`} viewBox="-80 -20 220 230">
      <g style={{ fill }} filter="url(#wx-crayon)">
        {angles.map((a) => (
          <path key={a} d={LEAF} transform={`rotate(${a} 30 200)`} />
        ))}
      </g>
    </svg>
  );
}

/** Crayon suns and leaves in the margins beside the home page's headline, never behind text. */
export function HeroDecorations() {
  return (
    <div className="deco" aria-hidden="true">
      <svg className="d d-sun" viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="47" style={{ fill: 'var(--sun)' }} filter="url(#wx-crayon)" />
      </svg>
      <Sprig className="d-leaves" fill="var(--leaf)" angles={[-34, -12, 10]} />
      <svg className="d d-ray-sun" viewBox="0 0 200 200">
        <g filter="url(#wx-crayon)">
          <g style={{ fill: 'var(--pink)' }}>
            {SUN_RAYS.map((d) => (
              <path key={d} d={d} />
            ))}
            <circle cx="100" cy="100" r="60" />
          </g>
          <circle cx="100" cy="100" r="40" style={{ fill: 'var(--yellow)' }} />
        </g>
      </svg>
      <Sprig className="d-pink" fill="var(--pinkd)" angles={[10, 34, 58]} />
    </div>
  );
}
