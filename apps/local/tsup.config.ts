import { defineConfig } from 'tsup';

// Bundle workspace packages into a single runnable file; npm dependencies
// (native llama.cpp and ONNX Runtime included) stay external.
export default defineConfig({
  entry: ['src/main.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@wexare\/(?!laya-web)/],
  removeNodeProtocol: false,
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
  clean: true,
});
