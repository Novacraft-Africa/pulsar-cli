import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {signCodePushJWT, SIGNATURE_PATH} from '../pulsar.js';
import {computePackageHash} from '../hash.js';
import {makeTempDir} from '../temp.js';

// Once an app ships CodePushPublicKey, a release that does not verify is rejected on every device,
// and fixing that needs a store release. So the signature must verify against the key keygen made.
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = makeTempDir('pulsar-keys-');
execFileSync(process.execPath, [path.join(here, '..', 'pulsar.js'), 'keygen'], {cwd: dir, stdio: 'pipe'});
const privateKey = fs.readFileSync(path.join(dir, 'pulsar-private.pem'), 'utf8');
const publicKey = fs.readFileSync(path.join(dir, 'pulsar-public.pem'), 'utf8');
assert.strictEqual(fs.statSync(path.join(dir, 'pulsar-private.pem')).mode & 0o777, 0o600, 'private key is owner-only');

const contentHash = 'a'.repeat(64);
const jwt = signCodePushJWT(privateKey, contentHash);
const [header, payload, signature] = jwt.split('.');
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());

// The shape the CodePush client reads out of .codepushrelease.
assert.deepStrictEqual(decode(header), {alg: 'RS256', typ: 'JWT'});
assert.deepStrictEqual(decode(payload), {contentHash});

// It verifies against the matching public key...
const verify = (key, input = `${header}.${payload}`) =>
  crypto.createVerify('RSA-SHA256').update(input).verify(key, Buffer.from(signature, 'base64url'));
assert.ok(verify(publicKey), 'signature verifies against the keygen public key');

// ...and not against a different key, nor for a different bundle.
const stranger = crypto.generateKeyPairSync('rsa', {modulusLength: 2048, publicKeyEncoding: {type: 'spki', format: 'pem'}, privateKeyEncoding: {type: 'pkcs8', format: 'pem'}}).publicKey;
assert.ok(!verify(stranger), 'a different key must not verify it');
const tampered = Buffer.from(JSON.stringify({contentHash: 'b'.repeat(64)})).toString('base64url');
assert.ok(!verify(publicKey, `${header}.${tampered}`), 'a signature for one bundle must not cover another');

// A key that is not a private key fails loudly rather than producing an unverifiable release.
assert.throws(() => signCodePushJWT('not a key', contentHash));

// Both native SDKs read <update>/CodePush/.codepushrelease only, and leave it out of the folder hash.
assert.strictEqual(SIGNATURE_PATH, 'CodePush/.codepushrelease');
const bundleDir = path.join(dir, 'bundle');
fs.mkdirSync(path.join(bundleDir, 'assets'), {recursive: true});
fs.writeFileSync(path.join(bundleDir, 'main.jsbundle'), 'code');
fs.writeFileSync(path.join(bundleDir, 'assets', 'logo.png'), 'png');
const unsignedHash = computePackageHash(bundleDir);
fs.mkdirSync(path.join(bundleDir, 'CodePush'));
fs.writeFileSync(path.join(bundleDir, SIGNATURE_PATH), signCodePushJWT(privateKey, unsignedHash));
assert.strictEqual(computePackageHash(bundleDir), unsignedHash, 'signing must not change the package hash');

console.log('signing.test.js: all assertions passed');
