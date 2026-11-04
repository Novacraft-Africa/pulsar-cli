import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeTempDir} from '../temp.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pulsar.js');
const dir = makeTempDir('pulsar entry-');
const link = path.join(dir, 'pulsar');
fs.symlinkSync(cli, link);
const run = (entry) => execFileSync(process.execPath, [entry], {encoding: 'utf8', env: {...process.env, HOME: dir}});

// A global install runs the CLI through a bin symlink, often under a path with spaces.
assert.match(run(link), /pulsar <login\|apps/, 'runs when invoked through a symlink');
assert.match(run(cli), /pulsar <login\|apps/, 'runs when invoked directly');
// Importing it must not run a command.
assert.strictEqual(execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(cli)})`], {encoding: 'utf8'}), '');

console.log('entry.test.js: all assertions passed');
