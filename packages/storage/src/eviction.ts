// Which saved model files to remove so a new download fits: the ones used
// least recently go first. Pure, so every app (and its tests) can share it.

export interface SavedFile {
  sha256: string;
  size: number;
  /** When a model last used this file, in ms since the epoch; 0 when unknown. */
  lastUsed: number;
}

export interface EvictionInput {
  files: SavedFile[];
  /** Bytes about to be downloaded. */
  needed: number;
  /** Most bytes saved files should take, the new download included. */
  limit: number;
  /** Bytes the browser still allows this site to store. */
  free: number;
  /** Files that must stay: the model about to run, and anything else in use. */
  keep?: ReadonlySet<string>;
  /** Headroom asked of the browser's free space. */
  margin?: number;
}

export interface EvictionPlan {
  /** Least recently used first. */
  remove: string[];
  freed: number;
  /** False when the download can't fit even after removing every file allowed; then nothing is removed. */
  ok: boolean;
}

/**
 * Files last used at the same moment were used together (one model's files)
 * and are removed together. The limit gives way to a download that is larger
 * than it on its own: every other file goes, and the download still runs if
 * the browser has room. Nothing is removed for a download that won't fit
 * anyway, since that would lose models for nothing.
 */
export function planEviction({ files, needed, limit, free, keep = new Set(), margin = 1.05 }: EvictionInput): EvictionPlan {
  let saved = files.reduce((n, f) => n + f.size, 0);
  let freed = 0;
  const remove: string[] = [];
  const roomInBrowser = () => free + freed >= needed * margin;
  const fits = () => saved + needed <= limit && roomInBrowser();

  const groups = new Map<number, SavedFile[]>();
  for (const f of files) if (!keep.has(f.sha256)) groups.set(f.lastUsed, [...(groups.get(f.lastUsed) ?? []), f]);
  for (const [, group] of [...groups].sort((a, b) => a[0] - b[0])) {
    if (fits()) break;
    for (const f of group) {
      remove.push(f.sha256);
      saved -= f.size;
      freed += f.size;
    }
  }
  if (!roomInBrowser()) return { remove: [], freed: 0, ok: false };
  return { remove, freed, ok: true };
}
