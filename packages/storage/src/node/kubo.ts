import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';

/**
 * Minimal Kubo RPC client (POST /api/v0/*) for operator tooling. The admin API
 * stays on the operator's machine; browsers only ever use public gateways.
 */
export class KuboClient {
  constructor(readonly api: string) {}

  private async rpc<T>(path: string, params: Record<string, string | boolean | number> = {}, body?: FormData): Promise<T> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const res = await fetch(`${this.api.replace(/\/+$/, '')}/api/v0/${path}?${qs}`, { method: 'POST', ...(body ? { body } : {}) });
    const text = await res.text();
    if (!res.ok) throw new Error(`kubo ${path} failed (${res.status}): ${text.slice(0, 300)}`);
    const last = text.trim().split('\n').pop() ?? '{}';
    return JSON.parse(last) as T;
  }

  async id(): Promise<{ ID: string; AgentVersion: string; Addresses: string[] | null }> {
    return this.rpc('id');
  }

  /** Add and pin a file as CIDv1 with raw leaves. Streams from disk. */
  async addFile(path: string, opts: { pin?: boolean; name?: string } = {}): Promise<{ cid: string; size: number }> {
    const blob = await openAsBlob(path);
    const form = new FormData();
    form.append('file', blob, opts.name ?? basename(path));
    const r = await this.rpc<{ Hash: string; Size: string }>('add', { 'cid-version': 1, 'raw-leaves': true, pin: opts.pin ?? true, quieter: true }, form);
    return { cid: r.Hash, size: Number(r.Size) };
  }

  async addBytes(bytes: Uint8Array, name: string, opts: { pin?: boolean } = {}): Promise<{ cid: string }> {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart]), name);
    const r = await this.rpc<{ Hash: string }>('add', { 'cid-version': 1, 'raw-leaves': true, pin: opts.pin ?? true, quieter: true }, form);
    return { cid: r.Hash };
  }

  /** Pin (fetching blocks from connected peers if needed). */
  async pinAdd(cid: string): Promise<void> {
    await this.rpc('pin/add', { arg: cid, recursive: true });
  }

  async isPinned(cid: string): Promise<boolean> {
    try {
      const r = await this.rpc<{ Keys?: Record<string, unknown> }>('pin/ls', { arg: cid, type: 'recursive' });
      return !!r.Keys?.[cid];
    } catch {
      return false;
    }
  }

  async swarmConnect(multiaddr: string): Promise<void> {
    await this.rpc('swarm/connect', { arg: multiaddr });
  }
}
