// Plain-language view of the verified local catalog. Everything technical
// (keys, hashes, runtimes, locations) stays in the engine; this layer only keeps
// models this browser can actually run, and says what they do.
import { resolveLoraDependency, type CandidateRelease } from '@wexare/orchestrator';
import { knownOutput, type FileLocation, type OperationConfig } from '@wexare/protocol';

/** An operation ID: what a model does, as its manifest names it. */
export type TaskId = string;

/** How a task reads in the app, taken from the manifest that offers it. */
export interface Task {
  id: TaskId;
  /** The filter word on the home page. */
  verb: string;
  /** Button label: says exactly what happens. */
  action: string;
  /** Heading above the answer. */
  result: string;
  placeholder: string;
  examples: string[];
  /** The model continues the text: show its answer after what was typed. */
  continues: boolean;
  /** The answer is code or a command line: shown as code, with a reminder to read it before running it. */
  code: boolean;
}

const sentence = (s: string) => (s ? `${s[0]!.toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? '' : '.'}` : s);

export function taskOf(op: OperationConfig): Task {
  const out = knownOutput(op);
  return {
    id: op.id,
    verb: op.title,
    action: op.title,
    result: op.title,
    placeholder: sentence(op.when),
    examples: op.examples ?? [],
    continues: op.prompt.mode === 'completion',
    code: out?.type === 'text' && !!out.code,
  };
}

/** Every task the listed models do, once each, by how many models do it. */
export function tasksOf(models: Model[]): Task[] {
  const count = new Map<TaskId, number>();
  const tasks = new Map<TaskId, Task>();
  for (const m of models) {
    for (const t of m.operations) {
      count.set(t.id, (count.get(t.id) ?? 0) + 1);
      if (!tasks.has(t.id)) tasks.set(t.id, t);
    }
  }
  return [...tasks.values()].sort((a, b) => count.get(b.id)! - count.get(a.id)! || a.verb.localeCompare(b.verb));
}

/** A label as a person reads it: "travel" → "Travel". */
export const labelText = (l: string) => (l ? l[0]!.toUpperCase() + l.slice(1) : l);

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
  /** How each task reads, in the order of `tasks`. */
  operations: Task[];
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
      if (!c.support.supported || !dep.ok || !dep.base?.support.supported) continue;
      base = dep.base;
      files = dep.files.map((f) => fileOf(f.sha256)).filter((f): f is ModelFile => !!f);
      // An add-on runs its own operations (its prompt, trained with it) on the base's weights.
      runnable = c.support.executableOperations;
    } else {
      if (!c.support.supported) continue;
      files = m.files.map((f) => ({ sha256: f.sha256, size: f.size, path: f.path, locations: f.locations }));
      runnable = c.support.executableOperations;
    }
    const ops = m.operations.filter((o) => m.capabilities.includes(o.id) && runnable.includes(o.id));
    const tasks = ops.map((o) => o.id);
    if (!tasks.length) continue;
    const totalBytes = files.reduce((n, f) => n + f.size, 0);
    models.push({
      id: c.eventId,
      name: friendlyName(m.name),
      description: m.description,
      tasks,
      operations: ops.map(taskOf),
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
