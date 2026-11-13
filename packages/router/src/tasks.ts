// What a request can ask for comes from the catalog: every operation a release
// offers is a task, found by its ID and described in its own words (`when`).
// Nothing here changes when publishers add models, tasks or categories.
//
// A few general requests are always offered next to them, so that System 1 can
// say "none of the models here": answering a question, translating, drafting a
// reply. Only an online model (or a general chat model) does those, unless a
// release offers the same task ID, in which case the release's own wording wins.
import type { CandidateRelease } from '@wexare/orchestrator';

export interface Task {
  /** The operation ID shared by every release that does it, or a general request's ID. */
  id: string;
  /** Short label people read: "Summarize". */
  title: string;
  /** The catalog category the task is filed under; general requests have none. */
  category?: string;
  /** The plain sentence System 1 reads to decide. */
  when: string;
  /** What an online model is told to do. */
  instruction: string;
}

/** Requests no catalog model is assumed to do; they make "none of these" a choice System 1 can make. */
export const GENERAL_TASKS: Task[] = [
  { id: 'answer', title: 'Answer a question', when: 'answer a question or explain something', instruction: 'Answer the question clearly and briefly.' },
  {
    id: 'translation',
    title: 'Translate',
    when: 'translate text into another language',
    instruction: 'Translate the text. If no target language is named, translate it into English. Reply with the translation only.',
  },
  { id: 'reply', title: 'Draft a reply', when: 'draft a reply to a message', instruction: 'Draft a short, polite reply to the message. Reply with the draft only.' },
];

/** The release whose wording stands for a task: a model before an add-on (which restyles its base), one that runs here, then a stable order. */
const representative = (a: CandidateRelease, b: CandidateRelease) =>
  Number(b.manifest.kind === 'model') - Number(a.manifest.kind === 'model') || Number(b.support.supported) - Number(a.support.supported) || (a.eventId < b.eventId ? -1 : 1);

/** Every task the catalog's models and add-ons offer, once each, in a stable order. */
export function catalogTasks(candidates: CandidateRelease[]): Task[] {
  const byId = new Map<string, Task>();
  for (const c of [...candidates].sort(representative)) {
    for (const op of c.manifest.operations) {
      if (byId.has(op.id)) continue;
      byId.set(op.id, {
        id: op.id,
        title: op.title,
        category: op.category,
        when: op.when,
        instruction: `${op.title}: ${op.when}. Reply with the result only.`,
      });
    }
  }
  return [...byId.values()].sort((a, b) => (a.category ?? '').localeCompare(b.category ?? '') || a.id.localeCompare(b.id));
}

/** The catalog's tasks, then the general requests no release covers. */
export function tasksFor(candidates: CandidateRelease[], general: Task[] = GENERAL_TASKS): Task[] {
  const catalog = catalogTasks(candidates);
  const ids = new Set(catalog.map((t) => t.id));
  return [...catalog, ...general.filter((g) => !ids.has(g.id))];
}
