// Copied unchanged from the weXare website (2026-10 brand).
// Keep the two in step; never redraw or restyle the shapes.

import { useId, type SVGProps } from "react";

/**
 * The official weXare mark (design-system/wexare-logo.svg, 2026-10): a human
 * heart with rounded lobes woven with an upside-down machine heart with
 * pixel-stepped lobes. The weave gaps are cut into the shapes, so each heart is
 * one group and the two can move apart without redrawing anything.
 *
 * The file draws four bands, not two hearts: each lobe runs on into a straight
 * strand, and two of those strands pass from one heart into the other at the
 * center crossings (the human heart's cleft is the machine heart's tip, and its
 * tip is the machine heart's cleft). So those two shapes are drawn twice, each
 * copy clipped to its heart's side of the crossing.
 *
 * Colors follow the roles in landing.css: `.wx-h` (human, pink) and `.wx-m`
 * (machine, navy). Never redraw or restyle the shapes; this is the file.
 */
export const LOGO_VIEWBOX = "0 0 721 707.66";

/** Machine left lobe, then up-right over the bottom crossing as the human heart's right side. */
const LEFT_PIXEL_BAND =
  "512.43 369.03 547.87 404.28 244.53 707.62 186.49 649.66 128.5 707.65 0 579.16 58 521.15 0 463.15 93.94 369.22 129 404.32 70.43 462.87 128.41 520.91 70.42 578.87 128.5 636.97 186.49 578.97 244.53 636.95 512.43 369.03";

/** Human right lobe, then down-left over the top crossing as the machine heart's left side. */
const RIGHT_ROUND_BAND =
  "M625.9,255.33c45.8-50.33,41.06-127.65-7.92-172.84-48.89-45.11-125.53-43.31-172.45,5.29l-237.07,237.07-35.3-35.18L417.26,46.72c67.43-65.34,175.34-60.52,239.77,4.28,65.63,66,67.79,172.14,3.19,240.77l-32.98,33.16-35.33-35.31,33.98-34.28Z";

/*
 * Each crossing is cut along the centerline of the strand passing under it:
 * y = x - 222.77 at the top, y = x + 195.8 at the bottom. The human side
 * reaches 2 units past the cut and is painted last, so no seam shows.
 */
const CUTS = {
  topHuman: "-100,-320.77 1000,779.23 1000,-400",
  topMachine: "-100,-322.77 1000,777.23 -100,1200",
  bottomHuman: "-100,97.8 1000,1197.8 1000,-400 -100,-400",
  bottomMachine: "-100,95.8 1000,1195.8 -100,1200",
};

interface WexareLogoProps extends SVGProps<SVGSVGElement> {
  /** Extra class for each heart group, e.g. to animate them separately. */
  heartClassName?: string;
  /** Accessible name; omit when the logo sits next to the word "weXare". */
  title?: string;
}

export function WexareLogo({ heartClassName, title, ...svgProps }: WexareLogoProps) {
  const id = useId();
  const heart = (role: "wx-h" | "wx-m") => (heartClassName ? `${role} ${heartClassName}` : role);
  const cut = (side: keyof typeof CUTS) => `url(#${id}-${side})`;

  return (
    <svg
      viewBox={LOGO_VIEWBOX}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
      {...svgProps}
    >
      <defs>
        {Object.entries(CUTS).map(([side, points]) => (
          <clipPath key={side} id={`${id}-${side}`}>
            <polygon points={points} />
          </clipPath>
        ))}
      </defs>
      <g className={heart("wx-m")}>
        <polygon points={LEFT_PIXEL_BAND} clipPath={cut("bottomMachine")} />
        <polygon points="417.91 578.39 476.51 636.97 534.5 578.95 592.5 636.98 650.58 578.88 592.6 520.91 650.57 462.86 382.65 194.96 417.64 159.79 720.98 463.12 663.01 521.16 721 579.13 592.52 707.65 534.5 649.65 476.5 707.66 382.59 613.72 417.91 578.39" />
        <path d={RIGHT_ROUND_BAND} clipPath={cut("topMachine")} />
      </g>
      <g className={heart("wx-h")}>
        <path d="M274.07,86.36c-47.43-47.48-123.44-48.42-171.51-3.38-48.84,45.29-52.67,122.14-7.71,172.33l243.65,243.64-35.35,35.35L60.69,291.82C-3.36,223.47-1.67,118.12,62.88,52.12,127.51-13.97,233.8-18.09,303.09,45.44l35.24,34.95-35.12,35.13-29.13-29.16Z" />
        <path d={RIGHT_ROUND_BAND} clipPath={cut("topHuman")} />
        <polygon points={LEFT_PIXEL_BAND} clipPath={cut("bottomHuman")} />
      </g>
    </svg>
  );
}
