// Whose releases this app shows. A signature proves who published a release
// and that its bytes are intact, not that anyone should run it; so a deployed
// app shows only approved publishers, and takes the System 1 router only from
// one approved for it. Local development shows every valid release.
//
// Approvals come in sources: today one, the list built into the app
// (WEXARE_PUBLISHERS). Community approvals, e.g. signed lists from curators
// this app trusts, become another source passed to `add`; a publisher is
// allowed a role when any approval grants it.
import type { PublisherApproval, PublisherRole } from '@wexare/web/src/lib/client-config.ts';

export class Trust {
  private readonly approvals = new Map<string, PublisherApproval[]>();

  constructor(readonly policy: 'any' | PublisherApproval[]) {
    if (policy !== 'any') this.add(policy);
  }

  /** Every validly signed release is shown. */
  get open(): boolean {
    return this.policy === 'any';
  }

  add(approvals: PublisherApproval[]): void {
    for (const a of approvals) this.approvals.set(a.pubkey, [...(this.approvals.get(a.pubkey) ?? []), a]);
  }

  allows(pubkey: string, role: PublisherRole): boolean {
    return this.open || !!this.approvals.get(pubkey)?.some((a) => a.roles.includes(role));
  }

  /** How to name a publisher to people: "weXare", or "Ana, approved by weXare". */
  describe(pubkey: string): string | null {
    const [a] = this.approvals.get(pubkey) ?? [];
    if (!a) return null;
    return a.approvedBy === a.label ? a.label : `${a.label}, approved by ${a.approvedBy}`;
  }

  /**
   * Keys to ask relays for, so they don't send everyone's releases; none when
   * open. A style add-on's base therefore needs an approved publisher too.
   */
  authors(): string[] | undefined {
    return this.open ? undefined : [...this.approvals.keys()];
  }
}
