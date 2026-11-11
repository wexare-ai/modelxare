// Exact LoRA base resolution. Compatibility is never inferred from names: the
// declared base release ID, manifest hash and weight hashes must all match a
// verified release in the local catalog.
import type { CandidateRelease } from './plan.ts';

export interface RequiredFile {
  sha256: string;
  size: number;
  path: string;
  role: string;
  eventId: string;
  cached: boolean;
}

export interface DependencyCheck {
  ok: boolean;
  base: CandidateRelease | null;
  problems: string[];
  files: RequiredFile[];
  totalBytes: number;
  missingBytes: number;
}

export function resolveLoraDependency(
  lora: CandidateRelease,
  lookup: (eventId: string) => CandidateRelease | null,
  isCached: (sha256: string) => boolean,
): DependencyCheck {
  const problems: string[] = [];
  const decl = lora.manifest.base;
  const files: RequiredFile[] = lora.manifest.files.map((f) => ({ sha256: f.sha256, size: f.size, path: f.path, role: f.role, eventId: lora.eventId, cached: isCached(f.sha256) }));
  let base: CandidateRelease | null = null;
  if (lora.manifest.kind !== 'lora' || !decl) {
    problems.push('not a LoRA release');
  } else {
    base = lookup(decl.release_id);
    if (!base) problems.push(`base release ${decl.release_id.slice(0, 16)}… is not in the verified local catalog`);
    else {
      if (base.manifest.kind !== 'model') problems.push('declared base is not a standalone model release');
      if (base.manifestSha256 !== decl.manifest_sha256) problems.push('declared base manifest hash does not match the base release');
      const weights = base.manifest.files.filter((f) => f.role === 'weights');
      for (const d of decl.files) {
        if (!weights.some((w) => w.sha256 === d.sha256 && w.size === d.size)) {
          problems.push(`declared base weights ${d.sha256.slice(0, 16)}… are not part of the base release (wrong base variant)`);
        }
      }
      for (const w of weights) files.push({ sha256: w.sha256, size: w.size, path: w.path, role: w.role, eventId: base.eventId, cached: isCached(w.sha256) });
    }
  }
  const unique = [...new Map(files.map((f) => [f.sha256, f])).values()];
  return {
    ok: problems.length === 0,
    base,
    problems,
    files: unique,
    totalBytes: unique.reduce((n, f) => n + f.size, 0),
    missingBytes: unique.filter((f) => !f.cached).reduce((n, f) => n + f.size, 0),
  };
}

/** The verified base of an adapter among `all` releases, or null when it doesn't resolve (wrong base, missing base). */
export function baseResolver(all: CandidateRelease[]): (lora: CandidateRelease) => CandidateRelease | null {
  const byId = new Map(all.map((c) => [c.eventId, c]));
  return (lora) => {
    const d = resolveLoraDependency(lora, (id) => byId.get(id) ?? null, () => false);
    return d.ok ? d.base : null;
  };
}
