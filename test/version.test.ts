import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SDK_NAME, SDK_VERSION } from '../src/version.ts';

test('context.sdk says what package.json says', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; name: string };
  assert.equal(SDK_VERSION, pkg.version);
  assert.equal(SDK_NAME, 'overblast-feedback-web');
  assert.equal(pkg.name, '@overblast/feedback');
});

test('nothing in the package reaches outside it', () => {
  // The folder is mirrored on its own (git subtree split): a relative import that climbs out of it
  // would not exist in the public repository.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const specifier = /(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+)['"]/g;
  for (const dir of ['src', 'test', 'scripts']) {
    for (const name of readdirSync(path.join(root, dir))) {
      const file = path.join(root, dir, name);
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(specifier)) {
        const target = path.resolve(path.dirname(file), m[1]!);
        assert.ok(target.startsWith(root), `${dir}/${name} imports ${m[1]}, outside the package`);
      }
    }
  }
});
