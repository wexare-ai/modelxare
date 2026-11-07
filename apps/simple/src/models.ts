// Plain-language view of the verified local catalog. Everything technical
// (keys, hashes, runtimes, locations) stays in the engine; this layer only keeps
// models this browser can actually run, and says what they do.
import { resolveLoraDependency, type CandidateRelease } from '@wexare/orchestrator';
import type { FileLocation } from '@wexare/protocol';

export type TaskId = 'summarization' | 'text-classification' | 'text-generation';

export interface Task {
  id: TaskId;
  /** The big filter word on the home page. */
  verb: string;
  /** Button label: says exactly what happens. */
  action: string;
  /** Heading above the answer. */
  result: string;
  placeholder: string;
  examples: string[];
}

export const TASKS: Task[] = [
  {
    id: 'summarization',
    verb: 'Summarize',
    action: 'Summarize',
    result: 'Summary',
    placeholder: 'Paste or type a message to summarize',
    examples: [
      'There has been a water leak near the entrance since this morning. Can someone inspect it?',
      'Hay una fuga de agua cerca de la entrada desde esta mañana. ¿Alguien puede revisarla?',
      'The people in apartment 4B have been playing loud music past midnight every night this week. Could someone please talk to them?',
    ],
  },
  {
    id: 'text-classification',
    verb: 'Sort',
    action: 'Sort message',
    result: 'Topic',
    placeholder: 'Paste or type a message to sort by topic',
    examples: [
      'There has been a water leak near the entrance since this morning. Can someone inspect it?',
      'The back gate lock is broken and anyone can walk in at night.',
      'The people in apartment 4B have been playing loud music past midnight every night this week. Could someone please talk to them?',
    ],
  },
  {
    id: 'text-generation',
    verb: 'Write',
    action: 'Write',
    result: 'Continued text',
    placeholder: 'Start a sentence and the model will continue it',
    examples: ['Once upon a time, a little fox', 'Look in thy glass', 'The old lighthouse keeper'],
  },
];

export const taskById = (id: string) => TASKS.find((t) => t.id === id);

/** Topic names for the bundled message categories. */
export const TOPICS: Record<string, string> = {
  maintenance: 'Maintenance',
  safety: 'Safety',
  security: 'Security',
  noise: 'Noise',
  cleanliness: 'Cleanliness',
  other: 'Other',
};

export interface ModelFile {
  sha256: string;
  size: number;
  path: string;
  locations: FileLocation[];
}

export interface Model {
  id: string;
  name: string;
  description: string;
  tasks: TaskId[];
  languages: string[];
  license: string;
  /** Every file this model needs here, including a style add-on's base model. */
  files: ModelFile[];
  totalBytes: number;
  /** Still to download on this device; 0 means ready. */
  downloadBytes: number;
  /** The release that runs: the model itself, or a style add-on applied to `base`. */
  release: CandidateRelease;
  base?: CandidateRelease;
}

/** "Tiny summarizer (SmolLM2 360M Q8_0)" → "Tiny summarizer". */
const friendlyName = (name: string) => name.replace(/\s*\([^)]*\)\s*$/, '').trim() || name;

const newer = (a: CandidateRelease, b: CandidateRelease) => a.version.localeCompare(b.version, undefined, { numeric: true }) > 0;

/**
 * `shown` picks the releases listed (approved publishers). Any release in the
 * local catalog can still be a listed style add-on's base: the add-on pins it
 * by hash.
 */
export function buildModels(candidates: CandidateRelease[], isCached: (sha256: string) => boolean, shown: (c: CandidateRelease) => boolean = () => true): Model[] {
  const byId = new Map(candidates.map((c) => [c.eventId, c]));
  const fileOf = (sha256: string): ModelFile | undefined => {
    for (const c of candidates) {
      const f = c.manifest.files.find((x) => x.sha256 === sha256);
      if (f) return { sha256: f.sha256, size: f.size, path: f.path, locations: f.locations };
    }
    return undefined;
  };

  // One entry per model: the newest version a publisher released.
  const latest = new Map<string, CandidateRelease>();
  for (const c of candidates) {
    if (!shown(c)) continue;
    const key = `${c.pubkey}:${c.modelId}`;
    const seen = latest.get(key);
    if (!seen || newer(c, seen)) latest.set(key, c);
  }

  const models: Model[] = [];
  for (const c of latest.values()) {
    const m = c.manifest;
    let base: CandidateRelease | undefined;
    let files: ModelFile[];
    let runnable: string[];
    if (m.kind === 'lora') {
      const dep = resolveLoraDependency(c, (id) => byId.get(id) ?? null, isCached);
      if (!dep.ok || !dep.base?.support.supported) continue;
      base = dep.base;
      files = dep.files.map((f) => fileOf(f.sha256)).filter((f): f is ModelFile => !!f);
      runnable = base.support.executableOperations;
    } else {
      if (!c.support.supported) continue;
      files = m.files.map((f) => ({ sha256: f.sha256, size: f.size, path: f.path, locations: f.locations }));
      runnable = c.support.executableOperations;
    }
    const tasks = TASKS.map((t) => t.id).filter((t) => m.capabilities.includes(t) && runnable.includes(t));
    if (!tasks.length) continue;
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    models.push({
      id: c.eventId,
      name: friendlyName(m.name),
      description: m.description,
      tasks,
      languages: m.languages,
      license: m.license.id,
      files,
      totalBytes,
      downloadBytes: files.filter((f) => !isCached(f.sha256)).reduce((n, f) => n + f.size, 0),
      release: c,
      ...(base ? { base } : {}),
    });
  }
  // Ready models first, then the smallest downloads.
  return mergeIdentical(models).sort((a, b) => Number(a.downloadBytes > 0) - Number(b.downloadBytes > 0) || a.downloadBytes - b.downloadBytes || a.name.localeCompare(b.name));
}

/**
 * Releases with byte-identical files that do the same tasks are the same model
 * to a person, whoever re-published them: show one, under the name most of
 * those releases use.
 */
function mergeIdentical(models: Model[]): Model[] {
  const groups = new Map<string, Model[]>();
  for (const m of models) {
    const key = `${m.files.map((f) => f.sha256).sort().join()}|${m.tasks.join()}`;
    groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups.values()].map((group) => {
    const votes = new Map<string, number>();
    for (const m of group) votes.set(m.name, (votes.get(m.name) ?? 0) + 1);
    const [name] = [...votes].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]!;
    return group.find((m) => m.name === name)!;
  });
}

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** ["en", "es"] → "English and Spanish". */
export function languageList(codes: string[]): string {
  const names = codes.map((c) => {
    try {
      return languageNames.of(c) ?? c;
    } catch {
      return c;
    }
  });
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(names);
}

/** Decimal units, rounded the way people read file sizes. */
export function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
