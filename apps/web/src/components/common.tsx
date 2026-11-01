import type { ReactNode } from 'react';
import { fingerprint, npub } from '../lib/format.ts';

export function Fingerprint({ pubkey }: { pubkey: string }) {
  return (
    <code className="fp" title={`${npub(pubkey)}\nhex ${pubkey}`}>
      {fingerprint(pubkey)}
    </code>
  );
}

export function Badge({ tone, children, title }: { tone: 'ok' | 'warn' | 'bad' | 'muted' | 'info'; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Four separate facts, never collapsed into one trust badge. */
export function StatusBadges(p: { cached: number; files: number; supported: boolean; reasons?: string[]; synthetic?: boolean }) {
  return (
    <span className="badges">
      <Badge tone="ok" title="Signature and inline manifest hash verified locally">
        metadata verified
      </Badge>
      {p.synthetic ? (
        <Badge tone="warn" title="Synthetic scale-test record: not a real model">
          synthetic
        </Badge>
      ) : (
        <Badge tone={p.cached === p.files ? 'ok' : 'muted'} title="Files downloaded and SHA-256 verified on this device">
          files {p.cached === p.files ? 'verified' : `${p.cached}/${p.files} verified`}
        </Badge>
      )}
      <Badge tone={p.supported ? 'ok' : 'bad'} title={p.reasons?.join('\n') || 'Runnable with the bundled runtime'}>
        {p.supported ? 'runtime supported' : 'runtime unsupported'}
      </Badge>
      <Badge tone="muted" title="No quality evaluation is performed or implied">
        quality not evaluated
      </Badge>
    </span>
  );
}

export function Progress({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
