// Writes strfry.conf from the template, with the relay's public description
// taken from the environment (strfry's config can't read it itself).
import { readFileSync } from 'node:fs';

const quote = (v) => JSON.stringify(String(v ?? ''));
const values = {
  RELAY_NAME: process.env.RELAY_NAME || 'modelXare relay',
  RELAY_DESCRIPTION: process.env.RELAY_DESCRIPTION || 'Signed modelXare model releases. Only kind 1063 events tagged wexare-micromodel are kept.',
  RELAY_CONTACT: process.env.RELAY_CONTACT || '',
};
const template = readFileSync(new URL('./strfry.conf.template', import.meta.url), 'utf8');
process.stdout.write(template.replace(/__([A-Z_]+)__/g, (m, k) => (k in values ? quote(values[k]) : m)));
