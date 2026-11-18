// What a build of the apps connects to, and whose releases it shows. Built in
// at build time (see ../../client-config.ts): the local development services
// by default, or a deployment's WEXARE_* environment variables. Public data
// only, never keys.

/** What an approved publisher may provide. */
export type PublisherRole = 'models' | 'router';

/**
 * One vouch for a publisher key. Today every approval comes from weXare and is
 * built into the app; community approvals (signed lists from curators) can be
 * added as further approvals of the same shape.
 */
export interface PublisherApproval {
  /** The publisher's public key, 64 hex characters. */
  pubkey: string;
  /** The name people see with this publisher's models. */
  label: string;
  /** Who vouches for this publisher, e.g. "weXare". */
  approvedBy: string;
  roles: PublisherRole[];
  /** The publisher's own site (https://), linked from its name. */
  site?: string;
}

export interface ClientConfig {
  relays: string[];
  ipfsGateways: string[];
  arweaveGateways: string[];
  /** WebSocket torrent trackers; none turns torrent downloads off. */
  trackers: string[];
  operatorStatusUrls: string[];
  /** "any": every validly signed release (local development). A list: only these publishers. */
  publishers: 'any' | PublisherApproval[];
  /** Where a new publisher asks to be approved, shown on the Xare page. */
  approvalRequest?: string;
  /** The repository this build's code comes from (https://, no trailing slash), linked in the header and the Xare steps. */
  sourceCode?: string;
  /** The site of who makes this app (https://), linked from "by weXare" in the header. */
  makerSite?: string;
}

declare const __CLIENT_CONFIG__: ClientConfig;

export const CLIENT_CONFIG: ClientConfig = __CLIENT_CONFIG__;
