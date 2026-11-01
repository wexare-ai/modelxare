// Deterministic local planning for the community-message workflow: detect the
// language, select one compatible release per stage, list required downloads.
import type { ReleaseManifest } from '@wexare/protocol';
import type { SupportResult } from '@wexare/runtime/support';

export const WORKFLOW_ID = 'wexare.workflow.community-message-triage/0.1';
export const STAGES = ['text-classification', 'summarization'] as const;
export type StageId = (typeof STAGES)[number];

export const LANGUAGE_NAMES: Record<string, string> = { en: 'English', es: 'Spanish', und: 'the same language as the message' };

const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'are', 'there', 'has', 'have', 'been', 'can', 'someone', 'since', 'near', 'of', 'to', 'it', 'this', 'please', 'morning', 'with', 'in', 'on', 'at', 'my', 'our', 'we', 'by'],
  es: ['el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'en', 'un', 'una', 'por', 'con', 'para', 'desde', 'hay', 'esta', 'está', 'puede', 'alguien', 'cerca', 'mañana', 'esta', 'nuestro', 'nuestra', 'se', 'muy', 'favor'],
};

/** Small deterministic en/es detector; returns `und` when unsure. Users can override. */
export function detectLanguage(text: string): string {
  const words = text.toLowerCase().normalize('NFC').match(/[\p{L}]+/gu) ?? [];
  const score = Object.fromEntries(Object.entries(STOPWORDS).map(([l, sw]) => [l, words.filter((w) => sw.includes(w)).length]));
  const [best, second] = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!best || best[1] < 2 || (second && best[1] === second[1])) return 'und';
  return best[0];
}

export interface CandidateRelease {
  eventId: string;
  pubkey: string;
  modelId: string;
  name: string;
  version: string;
  manifestSha256: string;
  manifest: ReleaseManifest;
  support: SupportResult;
}

export interface Preferences {
  /** Explicit user choice per stage (release event ID). */
  explicit?: Partial<Record<StageId, string>>;
  /** If any compatible release comes from these publishers, only those are considered. */
  preferredPublishers?: string[];
  /** Override detected language. */
  language?: string;
}

export interface StageSelection {
  stage: StageId;
  release: CandidateRelease | null;
  reason: string;
  considered: { eventId: string; name: string; pubkey: string; compatible: boolean; why: string }[];
}

export interface PlannedDownload {
  sha256: string;
  size: number;
  path: string;
  eventId: string;
}

export interface WorkflowPlan {
  workflow: string;
  input: string;
  language: string;
  languageSource: 'detected' | 'user';
  stages: StageSelection[];
  downloads: PlannedDownload[];
  downloadBytes: number;
  ok: boolean;
  problems: string[];
}

const totalBytes = (m: ReleaseManifest) => m.files.reduce((n, f) => n + f.size, 0);

export function compatibility(c: CandidateRelease, stage: StageId, language: string): { ok: boolean; why: string } {
  if (c.manifest.kind !== 'model') return { ok: false, why: 'adapters are not selected for workflow stages' };
  if (!c.manifest.capabilities.includes(stage)) return { ok: false, why: `does not declare ${stage}` };
  if (!c.support.executableOperations.includes(stage)) return { ok: false, why: `no executable ${stage} operation matching the bundled contract` };
  if (!c.support.supported) return { ok: false, why: c.support.reasons.join('; ') };
  if (language !== 'und' && !c.manifest.languages.includes(language) && !c.manifest.languages.includes('und')) {
    return { ok: false, why: `does not declare language ${language}` };
  }
  return { ok: true, why: 'compatible' };
}

/**
 * Selection order (spec §F6): explicit user choice, compatible cached release,
 * smaller compatible download, then stable publisher / release-ID tie-break.
 */
export function selectRelease(
  stage: StageId,
  candidates: CandidateRelease[],
  language: string,
  prefs: Preferences,
  isCached: (sha256: string) => boolean,
  isPending: (sha256: string) => boolean = () => false,
): StageSelection {
  const evaluated = candidates.map((c) => ({ c, ...compatibility(c, stage, language) }));
  const considered = evaluated.map((e) => ({ eventId: e.c.eventId, name: e.c.name, pubkey: e.c.pubkey, compatible: e.ok, why: e.why }));
  const explicitId = prefs.explicit?.[stage];
  if (explicitId) {
    const chosen = evaluated.find((e) => e.c.eventId === explicitId);
    if (!chosen) return { stage, release: null, reason: `your selected release ${explicitId.slice(0, 12)}… is not in the local catalog`, considered };
    if (!chosen.ok) return { stage, release: null, reason: `your selected release is not compatible: ${chosen.why}`, considered };
    return { stage, release: chosen.c, reason: 'explicit user choice', considered };
  }
  let pool = evaluated.filter((e) => e.ok).map((e) => e.c);
  if (pool.length === 0) {
    return { stage, release: null, reason: `no compatible release for ${stage}${language !== 'und' ? ` in ${LANGUAGE_NAMES[language] ?? language}` : ''} in the verified local catalog`, considered };
  }
  const preferred = pool.filter((c) => prefs.preferredPublishers?.includes(c.pubkey));
  if (preferred.length) pool = preferred;
  const cached = (c: CandidateRelease) => c.manifest.files.every((f) => isCached(f.sha256));
  // Files of an approved, in-progress download rank as cached, so the plan the
  // user approved does not switch releases as individual files finish.
  const available = (c: CandidateRelease) => c.manifest.files.every((f) => isCached(f.sha256) || isPending(f.sha256));
  pool.sort(
    (a, b) =>
      Number(available(b)) - Number(available(a)) ||
      totalBytes(a.manifest) - totalBytes(b.manifest) ||
      (a.pubkey < b.pubkey ? -1 : a.pubkey > b.pubkey ? 1 : 0) ||
      (a.eventId < b.eventId ? -1 : 1),
  );
  const winner = pool[0]!;
  const runnerUp = pool[1];
  let reason = cached(winner) ? 'compatible and already cached' : available(winner) ? 'compatible, download in progress' : 'smallest compatible download';
  if (runnerUp && available(winner) === available(runnerUp) && totalBytes(winner.manifest) === totalBytes(runnerUp.manifest)) reason = 'stable publisher / release-ID tie-break';
  if (preferred.length) reason += ' (preferred publisher)';
  return { stage, release: winner, reason, considered };
}

export function planWorkflow(
  input: string,
  candidates: CandidateRelease[],
  prefs: Preferences,
  isCached: (sha256: string) => boolean,
  /** Files queued or downloading: they rank as cached but still block execution. */
  isPending?: (sha256: string) => boolean,
): WorkflowPlan {
  const language = prefs.language ?? detectLanguage(input);
  const stages = STAGES.map((s) => selectRelease(s, candidates, language, prefs, isCached, isPending));
  const downloads = new Map<string, PlannedDownload>();
  for (const s of stages) {
    for (const f of s.release?.manifest.files ?? []) {
      if (!isCached(f.sha256) && !downloads.has(f.sha256)) downloads.set(f.sha256, { sha256: f.sha256, size: f.size, path: f.path, eventId: s.release!.eventId });
    }
  }
  const problems = stages.filter((s) => !s.release).map((s) => `${s.stage}: ${s.reason}`);
  if (!input.trim()) problems.push('input is empty');
  return {
    workflow: WORKFLOW_ID,
    input,
    language,
    languageSource: prefs.language ? 'user' : 'detected',
    stages,
    downloads: [...downloads.values()],
    downloadBytes: [...downloads.values()].reduce((n, d) => n + d.size, 0),
    ok: problems.length === 0,
    problems,
  };
}
