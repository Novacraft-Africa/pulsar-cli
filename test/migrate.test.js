import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {execFile, execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {computePackageHash} from '../hash.js';
import {makeTempDir} from '../temp.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pulsar.js');
const workDir = makeTempDir('pulsar-migrate-test-');

const bundleRoot = path.join(workDir, 'bundle');
fs.mkdirSync(path.join(bundleRoot, 'CodePush'), {recursive: true});
fs.writeFileSync(path.join(bundleRoot, 'CodePush', 'main.jsbundle'), 'console.log("v3")');
const bundleHash = computePackageHash(bundleRoot);
execFileSync('zip', ['-qq', '-r', '-X', path.join(workDir, 'source.zip'), '.'], {cwd: bundleRoot});
const bundleZip = fs.readFileSync(path.join(workDir, 'source.zip'));
const bytecodeRoot = path.join(workDir, 'bytecode');
fs.mkdirSync(path.join(bytecodeRoot, 'CodePush'), {recursive: true});
const bytecodeHeader = Buffer.alloc(4);
bytecodeHeader.writeUInt32LE(96);
fs.writeFileSync(path.join(bytecodeRoot, 'CodePush', 'index.android.bundle'), Buffer.concat([Buffer.from('c61fbc03c103191f', 'hex'), bytecodeHeader, Buffer.from('compiled')]));
execFileSync('zip', ['-qq', '-r', '-X', path.join(workDir, 'bytecode.zip'), '.'], {cwd: bytecodeRoot});
const bytecodeZip = fs.readFileSync(path.join(workDir, 'bytecode.zip'));

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const readBody = (request) => new Promise((resolve) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => resolve(Buffer.concat(chunks)));
});
const sendJson = (response, status, value) => {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(value));
};

const ACCESS_KEY = 'source-access-key';
let sourceUrl;
const sourcePackage = (label, blob, extra = {}) => ({
  label, appVersion: '1.2.0', description: 'fix crash', isMandatory: false, rollout: 100, isDisabled: false,
  blobUrl: `${sourceUrl}/blobs/${blob}`, packageHash: bundleHash, size: bundleZip.length, ...extra,
});
const sourceDeployments = () => ({
  'Shop-iOS': [
    {name: 'Production', key: 'src-ios-prod'},
    {name: 'QA', key: 'src-ios-qa', package: sourcePackage('v7', 'good.zip')},
    {name: 'Staging', key: 'src-ios-staging', package: sourcePackage('v3', 'good.zip', {isMandatory: true, rollout: 50})},
  ],
  'Shop-Android': [
    {name: 'Production', key: 'src-android-prod', package: sourcePackage('v2', 'good.zip', {isDisabled: true})},
    {name: 'Staging', key: 'src-android-staging', package: sourcePackage('v4', 'missing.zip')},
    {name: 'Beta', key: 'src-android-beta', package: sourcePackage('v5', 'bytecode.zip')},
  ],
});
const sourceRequests = [];
const sourceServer = await listen((request, response) => {
  sourceRequests.push({url: request.url, authorization: request.headers.authorization});
  const segments = request.url.split('/').filter(Boolean).map(decodeURIComponent);
  if (segments[0] === 'blobs') {
    const blob = {'good.zip': bundleZip, 'bytecode.zip': bytecodeZip}[segments[1]];
    if (!blob) return sendJson(response, 404, {error: 'gone'});
    response.writeHead(200, {'content-type': 'application/zip'});
    return response.end(blob);
  }
  if (request.headers.authorization !== `Bearer ${ACCESS_KEY}`) return sendJson(response, 401, {error: 'unauthorized'});
  const deployments = sourceDeployments();
  if (segments.length === 1) return sendJson(response, 200, {apps: Object.keys(deployments).map((name) => ({name, deployments: deployments[name].map((entry) => entry.name)}))});
  const appDeployments = deployments[segments[1]];
  if (segments.length === 3) return sendJson(response, 200, {deployments: appDeployments.map(({name, key}) => ({name, key}))});
  return sendJson(response, 200, {deployment: appDeployments.find((entry) => entry.name === segments[3])});
});
sourceUrl = `http://127.0.0.1:${sourceServer.address().port}`;

const pulsarApps = [{
  id: 'app-ios', orgId: 'org-1', name: 'Shop-iOS', os: 'ios',
  deployments: {Staging: {key: 'pulsar-ios-staging'}, Production: {key: 'pulsar-ios-prod'}},
}];
const pulsarReleases = {};
const pulsarWrites = [];
const pulsarServer = await listen(async (request, response) => {
  const body = await readBody(request);
  const segments = request.url.split('/').filter(Boolean);
  if (request.method !== 'GET') pulsarWrites.push({method: request.method, url: request.url, headers: request.headers, body});
  if (request.headers.authorization !== 'Bearer pulsar-token') return sendJson(response, 401, {error: 'unauthorized'});
  if (request.url === '/orgs') return sendJson(response, 200, [{id: 'org-1', name: 'Acme'}, {id: 'org-2', name: 'Other'}]);
  if (request.url === '/apps' && request.method === 'GET') return sendJson(response, 200, pulsarApps);
  if (request.url === '/apps' && request.method === 'POST') {
    const {name, os: platform, orgId} = JSON.parse(body);
    const app = {id: `app-${platform}`, orgId, name, os: platform, deployments: {Staging: {key: `pulsar-${platform}-staging`}, Production: {key: `pulsar-${platform}-prod`}}};
    pulsarApps.push(app);
    return sendJson(response, 201, app);
  }
  const app = pulsarApps.find((entry) => entry.id === segments[1]);
  if (!app) return sendJson(response, 404, {error: 'not found'});
  if (segments.length === 3 && request.method === 'POST') {
    const {name} = JSON.parse(body);
    app.deployments[name] = {key: `pulsar-${app.os}-${name.toLowerCase()}`};
    return sendJson(response, 201, {name, key: app.deployments[name].key});
  }
  const releaseKey = `${app.id}/${segments[3]}`;
  pulsarReleases[releaseKey] = pulsarReleases[releaseKey] || [];
  if (segments[4] === 'releases' && request.method === 'GET') return sendJson(response, 200, pulsarReleases[releaseKey]);
  if (segments[4] === 'sign') return sendJson(response, 200, {signature: null});
  if (segments[4] === 'release') {
    const release = {
      label: `v${pulsarReleases[releaseKey].length + 1}`,
      packageHash: request.headers['x-package-hash'],
      rollout: Number(request.headers['x-rollout']),
      isDisabled: request.headers['x-disabled'] === 'true',
    };
    pulsarReleases[releaseKey].push(release);
    return sendJson(response, 201, release);
  }
  return sendJson(response, 404, {error: 'not found'});
});
const pulsarUrl = `http://127.0.0.1:${pulsarServer.address().port}`;

const home = path.join(workDir, 'home');
fs.mkdirSync(home);
const runMigrate = (...extra) => promisify(execFile)(
  process.execPath,
  [cli, 'migrate', '--from', `${sourceUrl}/`, '--access-key', ACCESS_KEY, '--org', 'acme', ...extra],
  {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: home, TMPDIR: workDir, PULSAR_API_URL: pulsarUrl, PULSAR_TOKEN: 'pulsar-token'}},
);
const releaseUploads = () => pulsarWrites.filter((write) => write.url.endsWith('/release'));

const dryRun = await runMigrate('--dry-run');
assert.strictEqual(pulsarWrites.length, 0, 'a dry run writes nothing to Pulsar');
assert.ok(!sourceRequests.some((entry) => entry.url.startsWith('/blobs/')), 'a dry run downloads no bundles');
assert.match(dryRun.stdout, /Shop-iOS \[ios\]: reusing the existing Pulsar app/);
assert.match(dryRun.stdout, /Shop-Android \[android\]: would create in Acme/);
assert.match(dryRun.stdout, /QA\s+src-ios-qa\s+\(new\)\s+would re-release v7/);
assert.match(dryRun.stdout, /<string>http:\/\/127\.0\.0\.1:\d+<\/string>/, 'prints the Pulsar server URL to build with');
assert.ok(sourceRequests.filter((entry) => !entry.url.startsWith('/blobs/')).every((entry) => entry.authorization === `Bearer ${ACCESS_KEY}`));

const firstRun = await runMigrate();
assert.deepStrictEqual(
  pulsarWrites.filter((write) => write.url === '/apps').map((write) => JSON.parse(write.body)),
  [{name: 'Shop-Android', os: 'android', orgId: 'org-1'}],
  'creates only the app Pulsar does not have yet',
);
assert.deepStrictEqual(
  pulsarWrites.filter((write) => write.url.endsWith('/deployments')).map((write) => `${write.url} ${write.body}`),
  ['/apps/app-ios/deployments {"name":"QA"}', '/apps/app-android/deployments {"name":"Beta"}'],
  'reuses existing deployments and adds only the missing one',
);
assert.deepStrictEqual(releaseUploads().map((write) => write.url), [
  '/apps/app-ios/deployments/QA/release',
  '/apps/app-ios/deployments/Staging/release',
  '/apps/app-android/deployments/Production/release',
]);
const stagingUpload = releaseUploads()[1];
assert.strictEqual(stagingUpload.headers['x-app-version'], '1.2.0');
assert.strictEqual(stagingUpload.headers['x-package-hash'], bundleHash, 'the re-hashed bundle matches the source hash');
assert.strictEqual(stagingUpload.headers['x-is-mandatory'], 'true');
assert.strictEqual(stagingUpload.headers['x-rollout'], '50');
assert.strictEqual(stagingUpload.headers['x-disabled'], 'false');
assert.strictEqual(decodeURIComponent(stagingUpload.headers['x-description']), 'fix crash');
assert.strictEqual(releaseUploads()[2].headers['x-disabled'], 'true', 'a disabled source release stays disabled');
fs.writeFileSync(path.join(workDir, 'uploaded.zip'), stagingUpload.body);
assert.match(execFileSync('unzip', ['-l', path.join(workDir, 'uploaded.zip')], {encoding: 'utf8'}), /CodePush\/main\.jsbundle/);

assert.match(firstRun.stdout, /Staging\s+src-ios-staging\s+pulsar-ios-staging\s+v3 → v1/);
assert.match(firstRun.stdout, /Production\s+src-ios-prod\s+pulsar-ios-prod\s+no release on source/);
assert.match(firstRun.stdout, /Staging\s+src-android-staging\s+pulsar-android-staging\s+not migrated: download failed \(404\)/);
assert.match(firstRun.stdout, /Production\s+src-android-prod\s+pulsar-android-prod\s+v2 → v1 \(disabled\)/);
assert.match(firstRun.stdout, /Beta\s+src-android-beta\s+pulsar-android-beta\s+not migrated: v5 is Hermes bytecode v96; release it again from source with pulsar release/, 'a bytecode release is not copied, since it would reach builds that can\'t run it');

const writesBefore = pulsarWrites.length;
const secondRun = await runMigrate('--apps', 'Shop-iOS');
assert.strictEqual(pulsarWrites.length, writesBefore, 'running again does not duplicate apps, deployments or releases');
assert.match(secondRun.stdout, /v3 already on Pulsar as v1/);
assert.doesNotMatch(secondRun.stdout, /Shop-Android/);

const skipped = await runMigrate('--releases', 'none', '--apps', 'Shop-iOS');
assert.strictEqual(pulsarWrites.length, writesBefore);
assert.match(skipped.stdout, /skipped \(--releases none\)/);

sourceServer.close();
pulsarServer.close();
console.log('migrate.test.js: all assertions passed');
