// Plain-language view of the verified local catalog. Everything technical
// (keys, hashes, runtimes, locations) stays in the engine; this layer only keeps
// models this browser can actually run, and says what they do.
import { resolveLoraDependency, type CandidateRelease } from '@wexare/orchestrator';
import { MESSAGE_CATEGORIES, type FileLocation } from '@wexare/protocol';

export type TaskId = 'summarization' | 'text-classification' | 'text-generation' | 'command-generation';

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
  /** Examples for models of one tool, found by a word in the model's name. */
  examplesByTool?: { name: RegExp; examples: string[] }[];
}

export const TASKS: Task[] = [
  {
    id: 'summarization',
    verb: 'Summarize',
    action: 'Summarize',
    result: 'Summary',
    placeholder: 'Paste or type a message to summarize',
    examples: [
      'Hi Sam, because of a storm your flight to Lisbon on Friday will leave two hours late, at 16:40. Your seat and bags stay the same.',
      'Tu vuelo a Lisboa del viernes se retrasa dos horas por una tormenta. La nueva hora de salida es las 16:40.',
      'Your electricity bill of $84.20 is due on March 3. Pay online before then to avoid a late fee.',
    ],
  },
  {
    id: 'text-classification',
    verb: 'Sort',
    action: 'Sort message',
    result: 'Topic',
    placeholder: 'Paste or type a message to sort by topic',
    examples: [
      'Your order of running shoes has shipped and will arrive on Wednesday.',
      'Your electricity bill of $84.20 is due on March 3. Pay online before then to avoid a late fee.',
      'Your train to Berlin leaves from platform 7 in 20 minutes.',
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
  {
    id: 'command-generation',
    verb: 'Command',
    action: 'Get the command',
    result: 'Command',
    placeholder: 'Say in plain words what you want the tool to do',
    examples: ['Make a 200px thumbnail of photo.jpg', 'Stash my changes', 'Extract the audio from talk.mp4 as an mp3'],
    examplesByTool: [
      {
        name: /ffmpeg/i,
        examples: [
          'Extract the audio from talk.mp4 as an mp3',
          'Remove the sound from intro.mp4',
          'Resize video.mp4 to 1280 wide',
          'Convert holiday.mov to mp4 without re-encoding',
          'Rotate video.mp4 90 degrees',
        ],
      },
      {
        name: /\bgit\b/i,
        examples: [
          'Undo my last commit but keep the changes',
          'Create a branch called fix-login and switch to it',
          'Stash my changes',
          'Unstage README.md',
          'List remote branches',
        ],
      },
      {
        name: /magick/i,
        examples: [
          'Make a 200px thumbnail of photo.jpg',
          'Convert logo.png to a jpg with 80 quality',
          'Make picture.jpg black and white',
          'Convert logo.png to webp',
        ],
      },
    ],
  },
];

/** The examples to offer for a task on a given model. */
export const examplesFor = (task: Task, modelName: string): string[] =>
  task.examplesByTool?.find((t) => t.name.test(modelName))?.examples ?? task.examples;

export const taskById = (id: string) => TASKS.find((t) => t.id === id);

/** Topic names for the bundled message categories: "travel" → "Travel". */
export const TOPICS: Record<string, string> = Object.fromEntries(MESSAGE_CATEGORIES.map((c) => [c, c[0]!.toUpperCase() + c.slice(1)]));

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
