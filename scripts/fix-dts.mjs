/**
 * Point the emitted `.d.ts` files at the emitted `.js` files.
 *
 * ── THE HOLE THIS FILLS ─────────────────────────────────────────────────────────────────────────
 *
 * `rewriteRelativeImportExtensions` (tsconfig.json, and `sponsoredtokens-cli`'s for the same reason)
 * is what lets ONE set of sources be run three ways: the imports are written with a `.ts` extension,
 * so `node --test test/*.test.ts` resolves them as they stand under Node's own type stripping - Node
 * does NOT map `./client.js` onto `./client.ts`, which was measured rather than assumed - and the
 * compiler turns them into `.js` on the way into `dist/`.
 *
 * It rewrites the JAVASCRIPT and, as of TypeScript 5.9, not the DECLARATIONS. So `dist/index.js`
 * correctly says `from './client.js'` while `dist/index.d.ts` still says `from './client.ts'`, which
 * is a file that does not exist in the published package: every consumer's editor would resolve the
 * runtime module and fail on the types, which is the worst half of a package to get wrong, because
 * it only shows up in somebody else's IDE.
 *
 * The CLI does not meet this because it emits no declarations. This package is a library and must.
 *
 * ── WHAT IT TOUCHES ─────────────────────────────────────────────────────────────────────────────
 *
 * Only `.d.ts` files, only RELATIVE specifiers, and only the `.ts` extension at the end of one. A
 * package name is never relative and is never rewritten; a `.ts` inside a doc comment is not in a
 * specifier position and is not matched.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** `from './x.ts'`, `import('./x.ts')` and `export … from "./x.ts"` - quotes either way round. */
const SPECIFIER = /((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"]+)\.ts\2/g;

let files = 0;
let rewritten = 0;
for (const name of readdirSync(dist)) {
  if (!name.endsWith('.d.ts')) continue;
  files += 1;
  const file = path.join(dist, name);
  const before = readFileSync(file, 'utf8');
  const after = before.replace(SPECIFIER, (_match, lead, quote, specifier) => {
    rewritten += 1;
    return `${lead}${quote}${specifier}.js${quote}`;
  });
  if (after !== before) writeFileSync(file, after);
}

console.log(`fix-dts: ${rewritten} specifier${rewritten === 1 ? '' : 's'} in ${files} declaration file${files === 1 ? '' : 's'}`);

// A BUILD THAT EMITTED NO DECLARATIONS IS A BROKEN BUILD, not a quiet success: the package's
// `types` field would point at nothing and `npm publish` would ship it anyway.
if (files === 0) {
  console.error('fix-dts: dist/ has no .d.ts files - did `tsc -p tsconfig.json` run?');
  process.exit(1);
}
