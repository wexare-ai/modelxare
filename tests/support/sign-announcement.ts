// Test-only: sign a catalog announcement for arbitrary ZIP bytes, including
// deliberately bad archives, so the browser's own checks must reject them.
// Usage: tsx sign-announcement.ts <zip> <builder key file>
import { readFileSync } from 'node:fs';
import { finalizeEvent } from 'nostr-tools/pure';
import { buildCatalogAnnouncementTemplate, sha256Hex } from '@wexare/protocol';

const [zipPath, keyPath] = process.argv.slice(2);
if (!zipPath || !keyPath) throw new Error('usage: sign-announcement.ts <zip> <key>');
const zip = new Uint8Array(readFileSync(zipPath));
const key = JSON.parse(readFileSync(keyPath, 'utf8')) as { secret_key_hex: string };
const template = buildCatalogAnnouncementTemplate({
  zipSha256: sha256Hex(zip),
  zipSize: zip.length,
  // Never fetched: the tests hand the browser the local ZIP file.
  urls: ['http://127.0.0.1:9/unreachable.zip'],
  content: 'Acceptance-test archive (deliberately invalid contents).',
});
process.stdout.write(JSON.stringify(finalizeEvent(template, Uint8Array.from(Buffer.from(key.secret_key_hex, 'hex')))));
