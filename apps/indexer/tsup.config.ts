import { defineConfig } from 'tsup';

// Bundle workspace packages into a single runnable file; npm dependencies stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@wexare\//],
  // Keep `node:` specifiers: node:sqlite only exists with the prefix.
  removeNodeProtocol: false,
  // Bundled CommonJS dependencies call require(); give the ESM bundle a real one.
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  clean: true,
});
