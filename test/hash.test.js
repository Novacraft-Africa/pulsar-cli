import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {computePackageHash} from '../hash.js';

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(full), {recursive: true});
    fs.writeFileSync(full, contents);
  }
  return root;
}

// 1. Deterministic + order-independent.
const treeA = makeTree({'main.jsbundle': 'hello', 'assets/logo.png': 'world'});
const treeB = makeTree({'assets/logo.png': 'world', 'main.jsbundle': 'hello'});
assert.strictEqual(computePackageHash(treeA), computePackageHash(treeB), 'order must not matter');

// 2. Ignored files do not change the hash.
const base = computePackageHash(treeA);
fs.writeFileSync(path.join(treeA, '.DS_Store'), 'junk');
fs.mkdirSync(path.join(treeA, '__MACOSX'), {recursive: true});
fs.writeFileSync(path.join(treeA, '__MACOSX', 'x'), 'junk');
assert.strictEqual(computePackageHash(treeA), base, 'ignored files must not affect hash');

// 3. Content change changes the hash.
const treeC = makeTree({'main.jsbundle': 'hello!', 'assets/logo.png': 'world'});
assert.notStrictEqual(computePackageHash(treeC), base, 'content change must change hash');

// 4. Pinned vector (regression guard for the algorithm itself).
const pinned = makeTree({'main.jsbundle': 'hello', 'assets/logo.png': 'world'});
assert.strictEqual(
  computePackageHash(pinned),
  'ac4529a920e2fade2f746d5374e69eb67e3e55f52df04d330b948381f7800ecc',
  'algorithm output changed unexpectedly',
);

console.log('hash.test.js: all assertions passed');
