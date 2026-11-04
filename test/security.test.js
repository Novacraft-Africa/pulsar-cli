import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {makeTempDir} from '../temp.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// --- saveConfig: the token file must be owner-only (0600) and its dir 0700 ---------------------
const fakeHome = makeTempDir('pulsar-home-');
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome; // windows homedir source
const {saveConfig} = await import('../pulsar.js');
saveConfig({apiUrl: 'https://api.example.com', token: 'pulsar_ci_secret'});
const configFile = path.join(fakeHome, '.pulsar', 'config.json');
assert.ok(fs.existsSync(configFile), 'config file should be written');
assert.strictEqual(fs.statSync(configFile).mode & 0o077, 0, 'config file must not be group/other readable');
assert.strictEqual(fs.statSync(path.join(fakeHome, '.pulsar')).mode & 0o077, 0, 'config dir must be owner-only');

// --- keygen: the private signing key must be written 0600 --------------------------------------
const keyDir = makeTempDir('pulsar-keys-');
execFileSync('node', [path.join(here, '..', 'pulsar.js'), 'keygen'], {cwd: keyDir, stdio: 'ignore'});
const privateKey = path.join(keyDir, 'pulsar-private.pem');
assert.ok(fs.existsSync(privateKey), 'private key should be written');
assert.strictEqual(fs.statSync(privateKey).mode & 0o077, 0, 'private key must not be group/other readable');

console.log('cli/security.test.js: all assertions passed');
