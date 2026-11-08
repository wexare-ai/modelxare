import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { npubEncode } from 'nostr-tools/nip19';

export interface KeyFile {
  warning: string;
  label: string;
  created_at: string;
  secret_key_hex: string;
  pubkey: string;
  npub: string;
}

export interface LoadedKey {
  label: string;
  secretKey: Uint8Array;
  pubkey: string;
  npub: string;
  path: string;
}

/** Generate a key locally and store it with owner-only permissions. Never prints the secret. */
export async function generateKeyFile(path: string, label: string, opts: { force?: boolean } = {}): Promise<LoadedKey> {
  if (!opts.force && (await stat(path).catch(() => null))) throw new Error(`${path} already exists (use --force to overwrite)`);
  const sk = generateSecretKey();
  const pubkey = getPublicKey(sk);
  const file: KeyFile = {
    warning: 'PRIVATE KEY. Keep this file secret. Never commit, share, or embed it in manifests, archives or browser bundles.',
    label,
    created_at: new Date().toISOString(),
    secret_key_hex: bytesToHex(sk),
    pubkey,
    npub: npubEncode(pubkey),
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
  return { label, secretKey: sk, pubkey, npub: file.npub, path };
}

export async function loadKey(path: string): Promise<LoadedKey> {
  if (!path.trim()) throw new Error('no key file: the key path is empty (if it comes from a shell variable, set it in this shell)');
  const st = await stat(path).catch(() => null);
  if (!st) throw new Error(`key file ${path} not found (create one with: wexare keygen --out ${path})`);
  if ((st.mode & 0o077) !== 0) console.warn(`warning: ${path} is readable by other users; run chmod 600`);
  const f = JSON.parse(await readFile(path, 'utf8')) as KeyFile;
  const sk = hexToBytes(f.secret_key_hex);
  const pubkey = getPublicKey(sk);
  if (f.pubkey && f.pubkey !== pubkey) throw new Error(`${path}: stored pubkey does not match the secret key`);
  return { label: f.label, secretKey: sk, pubkey, npub: npubEncode(pubkey), path };
}

export async function ensureKey(path: string, label: string): Promise<LoadedKey> {
  return (await stat(path).catch(() => null)) ? loadKey(path) : generateKeyFile(path, label);
}
