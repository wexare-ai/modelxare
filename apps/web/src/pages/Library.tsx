import { useEffect, useState } from 'react';
import type { CandidateRelease } from '@wexare/orchestrator';
import { useApp, useChanges } from '../lib/app.tsx';
import { toCandidate } from '../lib/runtime.ts';
import { formatBytes, when } from '../lib/format.ts';
import { Badge, Section } from '../components/common.tsx';

export function Library() {
  const { artifacts, catalog, catalogVersion, go } = useApp();
  useChanges(artifacts);
  const [usage, setUsage] = useState<Awaited<ReturnType<typeof artifacts.usage>> | null>(null);
  const [cached, setCached] = useState<{ sha256: string; size: number; verifiedAt: number }[]>([]);
  const [cands, setCands] = useState<CandidateRelease[]>([]);
  const [checks, setChecks] = useState<Record<string, string>>({});

  useEffect(() => {
    void artifacts.usage().then(setUsage).catch(() => setUsage(null));
    void catalog.cachedArtifacts().then(setCached);
    void catalog.candidates().then((r) => setCands(r.map(toCandidate)));
  }, [artifacts, catalog, catalogVersion, artifacts.cached.size]);

  const usedBy = (sha: string) => cands.filter((c) => c.manifest.files.some((f) => f.sha256 === sha) || c.manifest.base?.files.some((f) => f.sha256 === sha));
  const verify = async (sha: string, size: number) => {
    setChecks((c) => ({ ...c, [sha]: 'hashing…' }));
    try {
      await artifacts.getVerifiedFile(sha, size);
      setChecks((c) => ({ ...c, [sha]: 'SHA-256 OK' }));
    } catch (e) {
      setChecks((c) => ({ ...c, [sha]: (e as Error).message }));
    }
  };

  return (
    <div>
      <Section
        title="Browser storage"
        actions={
          <div className="actions">
            <button onClick={() => navigator.storage.persist?.().then(() => artifacts.usage().then(setUsage))}>Request persistent storage</button>
            <button onClick={() => confirm('Delete every cached model file?') && artifacts.clearAll()} data-testid="clear-artifacts">
              Clear cached files
            </button>
          </div>
        }
      >
        {usage ? (
          <p>
            Origin usage {formatBytes(usage.usage)} of {formatBytes(usage.quota)} quota · {usage.files} verified files ({formatBytes(usage.bytes)}) in OPFS · storage{' '}
            {usage.persisted ? 'persistent' : 'best-effort (may be evicted)'}
          </p>
        ) : (
          <p>Storage estimate unavailable.</p>
        )}
      </Section>
      <Section title="Verified local files (content-addressed)">
        {cached.length === 0 && <p className="empty">No cached files. Download a release from its detail page or approve a plan in the Playground.</p>}
        <table className="files">
          <thead>
            <tr>
              <th>SHA-256</th>
              <th>Size</th>
              <th>Verified</th>
              <th>Used by releases</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {cached.map((a) => (
              <tr key={a.sha256} data-testid="cached-row">
                <td className="mono small">{a.sha256}</td>
                <td>{formatBytes(a.size)}</td>
                <td>{when(a.verifiedAt)}</td>
                <td>
                  {usedBy(a.sha256).map((c) => (
                    <div key={c.eventId}>
                      <a onClick={() => go({ page: 'model', id: c.eventId })}>{c.name}</a> {c.manifest.kind === 'lora' && <Badge tone="info">LoRA</Badge>}
                    </div>
                  ))}
                </td>
                <td>
                  <button onClick={() => verify(a.sha256, a.size)}>Re-verify</button> <button onClick={() => artifacts.remove(a.sha256)}>Remove</button>
                  {checks[a.sha256] && <div className="small">{checks[a.sha256]}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">Files are identified by hash, never by filename or display name. Releases sharing the same base weights share one cached copy.</p>
      </Section>
    </div>
  );
}
