// Starts the server. A hosted build (npm run build --workspace server) runs the compiled
// dist/server.mjs; on the shop PC there is no dist folder, so it runs the TypeScript source with tsx.
import { existsSync } from 'node:fs';

const compiled = new URL('../dist/server.mjs', import.meta.url);
if (existsSync(compiled)) {
  await import(compiled.href);
} else {
  const { register } = await import('tsx/esm/api');
  register();
  await import('../src/index.ts');
}
