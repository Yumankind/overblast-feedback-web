/**
 * The script-tag build: one self-contained file, `dist/overblast-feedback.global.js`, that puts
 * `window.OverblastFeedback` on the page. tsc has already written the ESM and the declarations;
 * this adds the IIFE beside them and prints the sizes, raw and gzipped, of both entry points.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const out = path.join(root, 'dist', 'overblast-feedback.global.js');

await build({
  entryPoints: [path.join(root, 'src', 'global.ts')],
  outfile: out,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  // ES2020: optional chaining and `??` stay as written (Safari 14, Chrome 80, Firefox 74 and
  // later), class fields and anything newer are lowered.
  target: ['es2020'],
  minify: true,
  legalComments: 'none',
  banner: { js: `/*! @overblast/feedback ${pkg.version} | MIT | github.com/Yumankind/overblast-feedback-web */` },
  logLevel: 'warning',
});

// The ESM entry as an application's bundler would see it: everything reachable from index.js.
const esm = await build({
  entryPoints: [path.join(root, 'dist', 'index.js')],
  bundle: true,
  format: 'esm',
  minify: true,
  write: false,
  logLevel: 'warning',
});

const size = (label, buf) => {
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`${label.padEnd(44)} ${kb(buf.length).padStart(9)}  gzip ${kb(gzipSync(buf).length).padStart(8)}`);
};
size('dist/overblast-feedback.global.js (IIFE)', readFileSync(out));
size('dist/index.js (ESM, bundled + minified)', Buffer.from(esm.outputFiles[0].contents));
