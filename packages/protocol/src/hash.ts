import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const utf8 = (s: string): Uint8Array => utf8ToBytes(s);
export const utf8Length = (s: string): number => utf8ToBytes(s).length;

/** Lowercase hex SHA-256 of bytes, or of a string's exact UTF-8 encoding. */
export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

export const HEX64 = /^[0-9a-f]{64}$/;
export const HEX128 = /^[0-9a-f]{128}$/;
export const isHex64 = (s: unknown): s is string => typeof s === 'string' && HEX64.test(s);
