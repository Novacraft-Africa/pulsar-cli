#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {computePackageHash, fileHashes} from './hash.js';
import {migrate} from './migrate.js';
import {privateContext, reportReach, sealArtifact, openArtifact, sealedHeaders, cmdBundleKey, cmdChanges} from './private.js';
import {bundleFileName, buildBytecode, findComposeScript, findHermesc, hermesChoice} from './hermes.js';
import {execFileSyncInterruptible, makeTempDir, removeTemp, trackTemp} from './temp.js';

// Code signing: sign the package hash into an RS256 JWT the client verifies against its
// CodePushPublicKey (Info.plist). Both native SDKs read it from <update>/CodePush/.codepushrelease
// and nowhere else; a signature anywhere else counts as no signature.
const SIGNATURE_PATH = 'CodePush/.codepushrelease';

function signCodePushJWT(privateKeyPem, contentHash) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const signingInput = `${encode({alg: 'RS256', typ: 'JWT'})}.${encode({contentHash})}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem).toString('base64url');
  return `${signingInput}.${signature}`;
}

function cmdKeygen() {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {type: 'spki', format: 'pem'},
    privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
  });
  fs.writeFileSync('pulsar-private.pem', privateKey, {mode: 0o600});
  fs.writeFileSync('pulsar-public.pem', publicKey);
  console.log('✓ wrote pulsar-private.pem (keep secret, use with --private-key) and pulsar-public.pem');
  console.log('  Put the public key in Info.plist <key>CodePushPublicKey</key> to require signed updates.');
}

const CONFIG_DIR = path.join(os.homedir(), '.pulsar');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  const fromFile = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  return {
    apiUrl: process.env.PULSAR_API_URL || fromFile.apiUrl,
    token: process.env.PULSAR_TOKEN || fromFile.token,
    deviceId: fromFile.deviceId,
  };
}

function saveConfig(config) {
  // The config holds a bearer token — keep the dir and file owner-only so other local users on a
  // shared host can't read the session.
  const deviceId = config.deviceId || loadConfig().deviceId;
  fs.mkdirSync(CONFIG_DIR, {recursive: true, mode: 0o700});
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({...config, deviceId}, null, 2), {mode: 0o600});
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* best-effort on pre-existing files */ }
}

const STALE_CONNECTION_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET']);

// A build blocks the event loop, so the server can close the pooled keep-alive connection unseen
// and the next request lands on a dead socket. Only a GET is safe to send twice.
async function send(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (options.method !== 'GET' || !STALE_CONNECTION_CODES.has(err?.cause?.code)) throw err;
    return fetch(url, options);
  }
}

async function api(pathname, {method = 'GET', body, headers = {}, raw, allowAnonymous, onUploadProgress, optional} = {}) {
  const {apiUrl, token} = loadConfig();
  if (!apiUrl) die('No API url. Run: pulsar login <apiUrl>');
  // Every call except the login handshake must carry a token, so an expired or
  // cleared session fails here rather than silently issuing anonymous requests.
  if (!token && !allowAnonymous) die('Not authenticated. Run: pulsar login <apiUrl>');
  const options = {
    method,
    headers: {
      ...(token ? {authorization: `Bearer ${token}`} : {}),
      ...(raw ? {} : body ? {'content-type': 'application/json'} : {}),
      ...headers,
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  };
  // Stream a raw upload in chunks so we can report progress as the request drains to the socket.
  if (raw && onUploadProgress && body && body.length) {
    const total = body.length;
    let offset = 0;
    const chunkSize = 64 * 1024;
    options.body = new ReadableStream({
      pull(controller) {
        if (offset >= total) { controller.close(); return; }
        const end = Math.min(offset + chunkSize, total);
        controller.enqueue(body.subarray(offset, end));
        offset = end;
        onUploadProgress(offset, total);
      },
    });
    options.duplex = 'half';
  }
  const response = await send(apiUrl.replace(/\/$/, '') + pathname, options);
  const text = await response.text();
  // Check the status BEFORE parsing: an edge/proxy error (413, 502, 524) returns
  // an HTML page, and parsing that first turned every such failure into an
  // opaque "Unexpected token '<'" SyntaxError instead of the real status.
  if (!response.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text).error || text;
    } catch {
      detail = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
    }
    if (optional) throw Object.assign(new Error(`${response.status} ${detail}`), {status: response.status});
    die(`${response.status} ${response.statusText}: ${detail}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    die(`${response.status}: expected JSON, got ${text.slice(0, 200)}`);
  }
}

function die(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    if (hidden) {
      rl.query = question;
      rl._writeToOutput = (text) => rl.output.write(text === rl.query ? text : '');
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

// Returns an onUploadProgress callback that renders a single updating line (or plain lines in CI).
function uploadProgress(label) {
  let lastPct = -1;
  return (sent, total) => {
    const pct = Math.floor((sent / total) * 100);
    if (pct === lastPct && sent < total) return;
    lastPct = pct;
    const line = `• ${label} — ${pct}% (${(sent / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB)`;
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${line}   `);
      if (sent >= total) process.stdout.write('\n');
    } else if (sent >= total) {
      console.log(line);
    }
  };
}

function openBrowser(url) {
  try {
    if (process.platform === 'darwin') execFileSync('open', [url], {stdio: 'ignore'});
    else if (process.platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], {stdio: 'ignore'});
    else execFileSync('xdg-open', [url], {stdio: 'ignore'});
  } catch { /* the URL is printed too, so the user can open it manually */ }
}

function dashboardUrl(apiUrl) {
  try {
    const parsed = new URL(apiUrl);
    parsed.host = parsed.host.replace(/^api\./, '');
    return `${parsed.protocol}//${parsed.host}`;
  } catch { return apiUrl.replace(/\/$/, ''); }
}

// Browser login: spin up a throwaway localhost server, open the dashboard's /cli-login page which
// (once you're signed in) redirects back here with a token. No password ever touches the terminal.
function browserLogin(apiUrl) {
  // A random nonce ties the callback to THIS login: the dashboard echoes it back and we reject any
  // callback whose state doesn't match, so a stray page spraying the loopback port range can't inject
  // its own token into our config (login fixation).
  const state = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      if (requestUrl.pathname !== '/callback') { res.writeHead(204); res.end(); return; }
      const token = requestUrl.searchParams.get('token');
      const ok = token && requestUrl.searchParams.get('state') === state;
      res.writeHead(ok ? 200 : 400, {'content-type': 'text/html'});
      res.end(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#080a0f;color:#eef2f7;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2 style="font-weight:600">${ok ? 'Pulsar CLI authorized ✓' : 'Authorization failed'}</h2><p style="color:#8f98a6">You can close this tab and return to your terminal.</p></div></body>`);
      if (!ok) return;
      setTimeout(() => { try { server.close(); } catch {} }, 100);
      resolve(token);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const {port} = server.address();
      const authUrl = `${dashboardUrl(apiUrl)}/cli-login?port=${port}&state=${state}`;
      console.log(`\n  Authorize the CLI in your browser:\n  ${authUrl}\n`);
      openBrowser(authUrl);
      console.log('  Waiting for authorization…');
    });
    setTimeout(() => { try { server.close(); } catch {} reject(new Error('Login timed out after 3 minutes')); }, 180000);
  });
}

async function resolveApp(nameOrId, platform) {
  const apps = await api('/apps');
  const byId = apps.find((app) => app.id === nameOrId);
  if (byId) return byId;
  const named = apps.filter((app) => app.name === nameOrId);
  if (!named.length) die(`App not found: ${nameOrId}. Known: ${apps.map((app) => `${app.name} [${app.os}]`).join(', ') || '(none)'}`);
  if (named.length === 1) return named[0];
  // Same name for an iOS and an Android app — disambiguate by platform (or the app id).
  const forPlatform = platform && named.find((app) => app.os === platform);
  if (forPlatform) return forPlatform;
  die(`Multiple apps named "${nameOrId}" (${named.map((app) => app.os).join(', ')}). Pass --platform ios|android, or use the app id.`);
}

function bundle(platform, contentsDir, sourcemapPath, {forHermes = false} = {}) {
  const bundleName = bundleFileName(platform);
  fs.mkdirSync(contentsDir, {recursive: true});
  console.log(forHermes ? `• bundling ${platform} unminified for the Hermes compiler, as React Native's release build does…` : `• bundling ${platform}…`);
  execFileSyncInterruptible(
    'npx',
    [
      'react-native',
      'bundle',
      '--platform', platform,
      '--dev', 'false',
      ...(forHermes ? ['--minify', 'false'] : []),
      '--entry-file', 'index.js',
      '--bundle-output', path.join(contentsDir, bundleName),
      '--assets-dest', contentsDir,
      ...(sourcemapPath ? ['--sourcemap-output', sourcemapPath] : []),
    ],
    {stdio: 'inherit'},
  );
}

function fileManifest(contentsDir) {
  const hashes = fileHashes(contentsDir);
  return Object.fromEntries(Object.entries(hashes).map(([relativePath, hash]) => [relativePath, {hash, size: fs.statSync(path.join(contentsDir, relativePath)).size}]));
}

function sizeGrowth(previousSize, nextSize) {
  if (!(previousSize > 0) || !(nextSize > 0)) return null;
  return Math.round(((nextSize - previousSize) / previousSize) * 100);
}

function growthChecks(previous, {size, jsSize = null, hermes = false}) {
  const previousJsSize = previous?.hermes ? previous.jsCopy?.size : previous?.size;
  const checks = hermes
    ? [{name: 'bytecode', previousSize: previous?.hermes ? previous.size : null, size}, {name: 'JavaScript copy', previousSize: previousJsSize, size: jsSize}]
    : [{name: 'bundle', previousSize: previousJsSize, size}];
  return checks.map((check) => ({...check, growth: sizeGrowth(check.previousSize, check.size)}));
}

function zipContents(contentsDir) {
  const zipDir = makeTempDir('pulsar-zip-');
  const zipPath = path.join(zipDir, 'release.zip');
  execFileSyncInterruptible('zip', ['-qq', '-r', '-X', zipPath, '.'], {cwd: contentsDir});
  const zip = fs.readFileSync(zipPath);
  removeTemp(zipDir);
  return zip;
}

// Build a differential package: only the files that changed vs the base, plus a hotcodepush.json
// manifest listing deleted files. The client reconstructs the full bundle from its current copy +
// this diff, then verifies the result against the target hash. Returns the diff dir, or null if the
// base couldn't be fetched.
async function buildDiffPackage(baseZip, newDir) {
  const baseWorkDir = makeTempDir('pulsar-base-');
  const basePath = path.join(baseWorkDir, 'base.zip');
  const baseDir = path.join(baseWorkDir, 'contents');
  fs.writeFileSync(basePath, baseZip);
  execFileSyncInterruptible('unzip', ['-qq', '-o', basePath, '-d', baseDir]);

  const baseHashes = fileHashes(baseDir);
  removeTemp(baseWorkDir);
  const newHashes = fileHashes(newDir);
  const diffDir = makeTempDir('pulsar-diff-');

  for (const [relativePath, hash] of Object.entries(newHashes)) {
    if (baseHashes[relativePath] === hash) continue;
    const dest = path.join(diffDir, relativePath);
    fs.mkdirSync(path.dirname(dest), {recursive: true});
    fs.copyFileSync(path.join(newDir, relativePath), dest);
  }
  const deletedFiles = Object.keys(baseHashes).filter((relativePath) => !(relativePath in newHashes));
  fs.writeFileSync(path.join(diffDir, 'hotcodepush.json'), JSON.stringify({deletedFiles}));
  // The signature isn't part of the content hash, so it's excluded above — but the patched bundle
  // still needs it to verify, so carry it into the diff when the release is signed.
  const signature = path.join(newDir, SIGNATURE_PATH);
  if (fs.existsSync(signature)) {
    fs.mkdirSync(path.dirname(path.join(diffDir, SIGNATURE_PATH)), {recursive: true});
    fs.copyFileSync(signature, path.join(diffDir, SIGNATURE_PATH));
  }
  return diffDir;
}

async function fetchBlob(apiUrl, appId, fileName) {
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/download/${appId}/${fileName}`);
  if (!response.ok) throw new Error(`download ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const splitList = (value, separator) => String(value || '').split(separator).map((entry) => entry.trim()).filter(Boolean);

// --schedule takes either an absolute instant ("2026-09-20T09:00:00Z", "2026-09-20 09:00") or a
// relative offset from now ("+90m", "+6h", "+3d"). Resolved here so the API only sees ISO.
function parseSchedule(value) {
  if (value === undefined) return null;
  const raw = String(value).trim();
  const relative = raw.match(/^\+(\d+(?:\.\d+)?)\s*(m|h|d)$/i);
  if (relative) {
    const unit = {m: 60000, h: 3600000, d: 86400000}[relative[2].toLowerCase()];
    return new Date(Date.now() + Number(relative[1]) * unit).toISOString();
  }
  const at = Date.parse(raw.includes('T') || !raw.includes(' ') ? raw : raw.replace(' ', 'T'));
  if (!Number.isFinite(at)) die(`Invalid --schedule "${raw}". Use an ISO instant or a relative offset like +6h.`);
  if (at <= Date.now()) die(`--schedule "${raw}" is in the past.`);
  return new Date(at).toISOString();
}

// --ramp takes "<to>@<hours>" ("100@48") or just "<hours>" (ramps to 100).
function parseRamp(value) {
  if (value === undefined) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(?:(\d{1,3})@)?(\d+(?:\.\d+)?)$/);
  if (!match) die(`Invalid --ramp "${raw}". Use <toPercent>@<hours>, e.g. 100@48.`);
  const to = match[1] === undefined ? 100 : Number(match[1]);
  if (to > 100) die('--ramp target cannot exceed 100.');
  return {to, hours: Number(match[2])};
}

function getFlag(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

async function cmdLogin(args) {
  const apiUrl = args[0] || (await prompt('API url: '));
  saveConfig({apiUrl, token: undefined});

  let mode;
  if (args.includes('--browser')) mode = 'browser';
  else if (args.includes('--api-key') || args.includes('--apikey')) mode = 'apikey';
  else if (args.includes('--terminal')) mode = 'terminal';
  else {
    const answer = (await prompt('Sign in with [a]pi key or [b]rowser? (a/b): ')).toLowerCase();
    mode = answer.startsWith('a') ? 'apikey' : 'browser';
  }

  if (mode === 'apikey') {
    const token = (await prompt('Paste your Pulsar API key: ', true)).trim();
    if (!token) die('No API key provided.');
    saveConfig({apiUrl, token});
    const me = await api('/auth/me').catch(() => null);
    if (!me?.user?.email) {
      saveConfig({apiUrl, token: undefined});
      die('That API key was rejected. Create one in the dashboard → Settings → API keys.');
    }
    console.log(`✓ logged in as ${me.user.email} (api key)`);
    return;
  }

  if (mode === 'browser') {
    const token = await browserLogin(apiUrl);
    saveConfig({apiUrl, token});
    const me = await api('/auth/me').catch(() => null);
    console.log(`✓ logged in${me?.user?.email ? ` as ${me.user.email}` : ''} (browser)`);
    return;
  }

  const email = await prompt('Email: ');
  const password = await prompt('Password: ', true);
  const deviceId = loadConfig().deviceId || crypto.randomBytes(16).toString('hex');
  const {token, user} = await api('/auth/login', {method: 'POST', body: {email, password, client: 'cli'}, headers: {'x-device-id': deviceId}, allowAnonymous: true});
  saveConfig({apiUrl, token, deviceId});
  console.log(`✓ logged in as ${user.email} (${user.platformRole})`);
}

const HIDDEN_KEYS = 'Deployment keys are hidden for this login. Run "pulsar login" again to see them.';
const shownKey = (deployment) => deployment.key || `${deployment.keyHint || ''}•••• (hidden: run "pulsar login" again)`;

async function cmdApps() {
  const apps = await api('/apps');
  if (!apps.length) return console.log('(no apps)');
  for (const app of apps) {
    console.log(`\n${app.name}  [${app.os}]  ${app.id}`);
    for (const [name, deployment] of Object.entries(app.deployments)) {
      console.log(`  ${name.padEnd(11)} key: ${shownKey(deployment)}`);
    }
  }
}

// Sign for this app — with a local key when one was given, otherwise by asking Pulsar, which signs for
// anyone allowed to publish here. Each app can hold a different key, so a release train re-signs.
async function signForApp(app, deployment, contentsDir, packageHash, localKey, subject = '') {
  const signaturePath = path.join(contentsDir, SIGNATURE_PATH);
  fs.rmSync(signaturePath, {force: true});
  let signature = null;
  if (localKey) {
    try {
      signature = signCodePushJWT(localKey, packageHash);
    } catch (error) {
      die(`could not sign with the provided key (${error.message}) — nothing was uploaded`);
    }
  } else {
    ({signature} = await api(`/apps/${app.id}/deployments/${deployment}/sign`, {method: 'POST', body: {packageHash}}));
  }
  if (!signature) {
    console.log(`• ${app.name} has no signing key — uploading${subject ? ` ${subject}` : ''} unsigned`);
    return;
  }
  fs.mkdirSync(path.dirname(signaturePath), {recursive: true});
  fs.writeFileSync(signaturePath, signature);
  console.log(`• signed${subject ? ` ${subject}` : ''}${localKey ? ' with your local key' : ' by Pulsar'}`);
}

function reportBytecodeReach(bytecodeVersion, reach, target, recentDays) {
  const active = reach.activeDevices || 0;
  const matching = reach.bytecodeActiveDevices[bytecodeVersion] || 0;
  const others = Object.entries(reach.bytecodeActiveDevices)
    .filter(([reported, count]) => Number(reported) !== bytecodeVersion && count > 0)
    .map(([reported, count]) => `${count} run v${reported}`);
  if (!active) {
    console.log(`• Hermes bytecode v${bytecodeVersion}: no device on ${target} was active in the last ${recentDays} days. Builds get the bytecode once they report v${bytecodeVersion} (SDK 1.9 or later) and the JavaScript copy until then`);
    return;
  }
  console.log(`• Hermes bytecode v${bytecodeVersion}: ${matching} of ${active} devices active on ${target} in the last ${recentDays} days run bytecode v${bytecodeVersion} and get it; the other ${active - matching} get the JavaScript copy${others.length ? ` (${others.join(', ')})` : ''}`);
}

const supportsBytecode = (reach) => Boolean(reach?.bytecodeActiveDevices) && typeof reach.bytecodeActiveDevices === 'object';

function diffBases(app, previous, packageHash) {
  if (!previous) return [];
  const blobFile = (blobKey) => blobKey.slice(app.id.length + 1);
  const bases = [{
    label: previous.label,
    packageHash: previous.packageHash,
    file: previous.encrypted && previous.blobKey ? blobFile(previous.blobKey) : `${previous.packageHash}.zip`,
  }];
  if (previous.jsCopy?.packageHash && previous.jsCopy.blobKey) {
    bases.push({label: `${previous.label} JavaScript copy`, packageHash: previous.jsCopy.packageHash, file: blobFile(previous.jsCopy.blobKey), jsCopy: true});
  }
  return bases.filter((base) => base.packageHash && base.packageHash !== packageHash);
}

// Sign and push an already-built bundle to one app's deployment, then generate and upload a
// differential patch against whatever that deployment was serving.
async function pushBuiltRelease(app, deployment, args, contentsDir, packageHash, localKey, {sourcemapPath, reachReported = false, hermes = null, javascript = null} = {}) {
  if (hermes && !javascript) die('a Hermes bytecode release needs its JavaScript copy. Nothing was uploaded.');
  const privateBundles = await privateContext(app, args, localKey);
  const sealing = Boolean(privateBundles) && !privateBundles.plain;
  const plainCopy = sealing && args.includes('--plain-copy-for-old-builds');
  if (privateBundles && !reachReported) reportReach(privateBundles, {mandatory: args.includes('--mandatory'), plainCopy});
  await signForApp(app, deployment, contentsDir, packageHash, localKey);
  if (hermes) await signForApp(app, deployment, javascript.contentsDir, javascript.packageHash, localKey, 'the JavaScript copy');
  const sealFull = async (hash, bytes) => (sealing ? Buffer.from(await sealArtifact(privateBundles, app, hash, bytes, 'full')) : bytes);
  const plainZip = zipContents(contentsDir);
  const zip = await sealFull(packageHash, plainZip);
  const plainJsZip = hermes ? zipContents(javascript.contentsDir) : null;
  const jsZip = hermes ? await sealFull(javascript.packageHash, plainJsZip) : null;
  let prevLatest = null;
  try {
    const existing = await api(`/apps/${app.id}/deployments/${deployment}/releases`, {optional: true});
    prevLatest = [...existing].reverse().find((entry) => !entry.isDisabled) || existing[existing.length - 1] || null;
  } catch {}
  const target = getFlag(args, 'target');
  let binaries = null;
  try {
    binaries = await api(`/apps/${app.id}/binary-versions?target=${encodeURIComponent(target)}`, {optional: true});
  } catch (err) {
    if (hermes) die(`couldn't confirm that ${app.name}'s Pulsar server can serve Hermes bytecode (${err.message}). Pass --no-hermes to release JavaScript. Nothing was uploaded.`);
  }
  const {versions, reach, recentDays} = binaries || {};
  if (versions?.length && reach && !reach.everLaunched) {
    console.log(`⚠ no device has reported a store build matching ${target}; this release reaches nobody yet (builds seen: ${versions.slice(0, 5).map((entry) => entry.version).join(', ')})`);
  } else if (versions?.length && reach && !reach.recentLaunches) {
    console.log(`⚠ no store build matching ${target} was opened in the last ${recentDays} days (matches: ${reach.matchingVersions.join(', ')})`);
  }
  if (hermes) {
    if (!supportsBytecode(reach)) die(`${app.name}'s Pulsar server can't serve Hermes bytecode releases yet, so builds that can't run bytecode would get it too. Update the server, or pass --no-hermes to release JavaScript. Nothing was uploaded.`);
    reportBytecodeReach(hermes.bytecodeVersion, reach, target, recentDays);
  }
  const maxGrowth = getFlag(args, 'max-growth');
  for (const {name, previousSize, size, growth} of growthChecks(prevLatest, {size: zip.length, jsSize: jsZip?.length, hermes: Boolean(hermes)})) {
    if (growth !== null && growth > 20) {
      console.log(`⚠ ${name} is ${growth}% larger than ${prevLatest.label} (${(previousSize / 1e6).toFixed(2)}MB → ${(size / 1e6).toFixed(2)}MB)`);
    }
    if (maxGrowth !== undefined && growth !== null && growth > Number(maxGrowth)) {
      die(`${name} grew ${growth}%, more than --max-growth ${maxGrowth}%. Nothing was released.`);
    }
  }

  const startsAt = parseSchedule(getFlag(args, 'schedule'));
  const ramp = parseRamp(getFlag(args, 'ramp'));
  const release = await api(`/apps/${app.id}/deployments/${deployment}/release`, {
    method: 'POST',
    raw: true,
    body: zip,
    onUploadProgress: uploadProgress(`uploading ${(zip.length / 1e6).toFixed(1)}MB ${hermes ? 'bytecode ' : ''}bundle`),
    headers: {
      ...(sealing
        ? {...sealedHeaders, 'x-encrypted': '1', 'x-key-ids': privateBundles.keys.map((key) => key.kid).join(','), 'x-release-signature': fs.readFileSync(path.join(contentsDir, SIGNATURE_PATH), 'utf8')}
        : {'content-type': 'application/zip'}),
      ...(privateBundles?.plain === 'all' ? {'x-plain': '1'} : {}),
      ...(privateBundles?.plain === 'older' ? {'x-audience': 'older-builds'} : {}),
      ...(hermes ? {'x-hermes-bytecode-version': String(hermes.bytecodeVersion)} : {}),
      'x-app-version': target,
      'x-package-hash': packageHash,
      'x-is-mandatory': String(args.includes('--mandatory')),
      'x-disabled': String(args.includes('--disabled')),
      'x-rollout': String(getFlag(args, 'rollout', '100')),
      'x-client-ids': getFlag(args, 'devices', ''),
      // JSON-encoded: iOS model ids contain a comma ("iPhone14,3"), so separate models with ';'.
      'x-target-devices': JSON.stringify(splitList(getFlag(args, 'device-models', ''), ';')),
      'x-target-users': JSON.stringify(splitList(getFlag(args, 'users', ''), ',')),
      'x-target-from': JSON.stringify(splitList(getFlag(args, 'from', ''), ',')),
      'x-description': encodeURIComponent(getFlag(args, 'description', '')),
      ...(startsAt ? {'x-starts-at': startsAt} : {}),
      ...(ramp ? {'x-rollout-to': String(ramp.to), 'x-rollout-hours': String(ramp.hours)} : {}),
    },
  });
  if (hermes && release.hermes?.bytecodeVersion !== hermes.bytecodeVersion) {
    const disabled = await api(`/apps/${app.id}/deployments/${deployment}/releases/${release.label}`, {method: 'PATCH', body: {isDisabled: true}, optional: true}).then(() => true, () => false);
    die(`${app.name}'s Pulsar server stored ${release.label} without its Hermes bytecode version, so it would serve bytecode to builds that can't run it. ${disabled ? `${release.label} was disabled.` : `Disable ${release.label} in the dashboard now.`} Update the server, or release again with --no-hermes.`);
  }
  const scopes = [
    release.clientIds?.length ? `${release.clientIds.length} device id(s)` : null,
    release.targetDevices?.length ? `${release.targetDevices.length} device model(s)` : null,
    release.targetUserIds?.length ? `${release.targetUserIds.length} user(s)` : null,
    release.targetFromLabels?.length ? `devices on ${release.targetFromLabels.join('/')}` : null,
  ].filter(Boolean);
  const reachText = scopes.length ? scopes.join(' + ') : `${release.rollout}% of devices`;
  const privacy = release.encrypted ? ' (private)' : release.olderBuildsOnly ? ' (plain, older builds only)' : privateBundles ? ' (plain)' : '';
  const bytecode = hermes ? ` (Hermes bytecode v${hermes.bytecodeVersion})` : '';
  console.log(`✓ released ${release.label} to ${app.name}/${deployment} — ${release.isDisabled ? 'DISABLED' : reachText}${privacy}${bytecode}`);
  if (hermes) {
    try {
      await api(`/apps/${app.id}/deployments/${deployment}/releases/${release.label}/js-copy`, {
        method: 'POST',
        raw: true,
        optional: true,
        body: jsZip,
        onUploadProgress: uploadProgress(`uploading ${(jsZip.length / 1e6).toFixed(1)}MB JavaScript copy`),
        headers: {
          ...(sealing
            ? {...sealedHeaders, 'x-release-signature': fs.readFileSync(path.join(javascript.contentsDir, SIGNATURE_PATH), 'utf8')}
            : {'content-type': 'application/zip'}),
          'x-package-hash': javascript.packageHash,
        },
      });
    } catch (err) {
      die(`the JavaScript copy of ${release.label} was not uploaded (${err.message}). ${release.label} reaches only builds that run Hermes bytecode v${hermes.bytecodeVersion}; every other build stays on its current release. Release again, or disable ${release.label}.`);
    }
    console.log(`• JavaScript copy uploaded: builds that don't run Hermes bytecode v${hermes.bytecodeVersion} get it`);
  }
  if (plainCopy) {
    await api(`/apps/${app.id}/deployments/${deployment}/releases/${release.label}/plain-copy`, {
      method: 'POST',
      raw: true,
      body: hermes ? plainJsZip : plainZip,
      onUploadProgress: uploadProgress(`uploading ${((hermes ? plainJsZip : plainZip).length / 1e6).toFixed(1)}MB plain copy for older builds`),
      headers: {'content-type': 'application/zip', ...(hermes ? {'x-package-hash': javascript.packageHash} : {})},
    });
    console.log('• plain copy uploaded: older builds get this release too, and Pulsar can read that copy');
  }
  if (release.approval && !release.approval.approvedAt) {
    console.log(`⏸ waiting for approval: ${deployment} needs a second admin or owner to approve ${release.label} in the dashboard before devices get it`);
  }
  if (release.signed === false) {
    console.log('⚠ UNSIGNED — this build is blocked and will not reach devices. An org owner can enable it from the dashboard.');
  }
  if (release.startsAt) console.log(`  scheduled — goes live ${new Date(release.startsAt).toLocaleString()}`);
  if (release.rolloutRamp) console.log(`  gradual rollout — ${release.rollout}% to ${release.rolloutRamp.to}% over ${release.rolloutRamp.hours}h`);

  const modulesSourcemap = javascript?.sourcemapPath || sourcemapPath;
  try {
    const files = {files: fileManifest(contentsDir)};
    const sealedManifest = () => {
      let modules = null;
      try {
        modules = modulesSourcemap && fs.existsSync(modulesSourcemap) ? JSON.parse(fs.readFileSync(modulesSourcemap, 'utf8')).sources || null : null;
      } catch {
        modules = null;
      }
      return Buffer.from(JSON.stringify(modules ? {...files, modules} : files));
    };
    await api(`/apps/${app.id}/deployments/${deployment}/releases/${release.label}/manifest`, sealing
      ? {method: 'POST', raw: true, optional: true, body: await sealArtifact(privateBundles, app, packageHash, sealedManifest(), 'manifest'), headers: sealedHeaders}
      : {method: 'POST', body: files, optional: true});
  } catch (err) {
    console.log(`• file list not recorded: ${err.message}`);
  }
  const sourcemaps = [
    {mapPath: sourcemapPath, hash: packageHash, name: hermes ? 'bytecode source map' : 'source map'},
    ...(hermes ? [{mapPath: javascript.sourcemapPath, hash: javascript.packageHash, name: 'JavaScript copy source map', jsCopy: true}] : []),
  ];
  for (const {mapPath, hash, name, jsCopy} of sourcemaps) {
    if (!mapPath || !fs.existsSync(mapPath)) continue;
    try {
      const plainMap = fs.readFileSync(mapPath);
      const map = sealing ? Buffer.from(await sealArtifact(privateBundles, app, hash, plainMap, 'sourcemap')) : plainMap;
      await api(`/apps/${app.id}/deployments/${deployment}/releases/${release.label}/sourcemap`, {
        method: 'POST',
        raw: true,
        optional: true,
        body: map,
        onUploadProgress: uploadProgress(`uploading ${(map.length / 1e6).toFixed(1)}MB ${name}`),
        headers: {...(sealing ? sealedHeaders : {'content-type': 'application/json'}), ...(jsCopy ? {'x-package-hash': hash} : {})},
      });
      console.log(sealing ? `• ${name} uploaded, encrypted: unlock it in the dashboard or with pulsar changes` : `• ${name} uploaded: crash stacks for this release will show your source files`);
    } catch (err) {
      console.log(`• ${name} not uploaded: ${err.message}`);
    }
  }

  if (!args.includes('--no-diff')) {
    for (const base of diffBases(app, prevLatest, packageHash)) {
      try {
        const {apiUrl} = loadConfig();
        let baseZip = await fetchBlob(apiUrl, app.id, base.file);
        if (prevLatest.encrypted) {
          if (!privateBundles?.keys.length) throw new Error(`${prevLatest.label} is private and no bundle key was given`);
          baseZip = await openArtifact(privateBundles.keys, baseZip, {appId: app.id, packageHash: base.packageHash, kind: 'full'});
        }
        const diffDir = await buildDiffPackage(baseZip, contentsDir);
        const plainDiff = zipContents(diffDir);
        removeTemp(diffDir);
        const diffZip = sealing
          ? Buffer.from(await sealArtifact(privateBundles, app, packageHash, plainDiff, 'diff', {baseHash: base.packageHash}))
          : plainDiff;
        await api(`/apps/${app.id}/deployments/${deployment}/releases/${release.label}/diff`, {
          method: 'POST',
          raw: true,
          optional: true,
          body: diffZip,
          onUploadProgress: uploadProgress(`uploading ${(diffZip.length / 1e6).toFixed(1)}MB diff`),
          headers: {...(sealing ? sealedHeaders : {'content-type': 'application/zip'}), 'x-base-hash': base.packageHash},
        });
        const saved = Math.round((1 - diffZip.length / zip.length) * 100);
        console.log(`• diff vs ${base.label}: ${(diffZip.length / 1e3).toFixed(0)} KB (${saved}% smaller)`);
      } catch (err) {
        console.log(`• diff ${base.jsCopy ? `vs ${base.label} ` : ''}skipped (full bundle still serves): ${err.message}`);
      }
    }
  }
  return release;
}

// Build the JS bundle once and return what every target app's release is made from. A local key
// (--private-key <file>, or PULSAR_SIGNING_KEY holding the key itself) overrides Pulsar's signing.
function localSigningKey(args) {
  const privateKeyPath = getFlag(args, 'private-key');
  if (privateKeyPath && !fs.existsSync(privateKeyPath)) die(`no signing key at ${privateKeyPath} — drop --private-key to have Pulsar sign`);
  return privateKeyPath ? fs.readFileSync(privateKeyPath, 'utf8') : (process.env.PULSAR_SIGNING_KEY || '').trim();
}

async function checkPrivateBeforeBuild(apps, args) {
  const localKey = localSigningKey(args);
  for (const app of apps) {
    const context = await privateContext(app, args, localKey);
    if (context) reportReach(context, {mandatory: args.includes('--mandatory'), plainCopy: args.includes('--plain-copy-for-old-builds')});
  }
}

function hermesCompiler(args, projectRoot = process.cwd()) {
  const platform = getFlag(args, 'platform', 'ios');
  const choice = hermesChoice(args, projectRoot, platform);
  if (choice.error) die(`${choice.error}. Nothing was uploaded.`);
  if (!choice.enabled) return null;
  const hermesc = findHermesc(projectRoot);
  if (!hermesc) {
    die(`Hermes is on for ${platform}, but no Hermes compiler was found in node_modules (hermes-compiler/hermesc or react-native/sdks/hermesc). Install your dependencies, or pass --no-hermes to release JavaScript. Nothing was uploaded.`);
  }
  return {hermesc, composeScript: findComposeScript(projectRoot)};
}

function buildOnce(args, compiler = null) {
  const platform = getFlag(args, 'platform', 'ios');
  const localKey = localSigningKey(args);
  const contentsDir = makeTempDir('pulsar-build-');
  const sourcemapPath = args.includes('--no-sourcemap') ? null : trackTemp(`${contentsDir}.map`);
  bundle(platform, contentsDir, sourcemapPath);
  const packageHash = computePackageHash(contentsDir);
  console.log(`• hash ${packageHash.slice(0, 12)}…`);
  if (!compiler) return {contentsDir, packageHash, localKey, sourcemapPath};
  const sourceDir = makeTempDir('pulsar-hermes-source-');
  const sourceMapPath = sourcemapPath ? trackTemp(`${sourceDir}.map`) : null;
  bundle(platform, sourceDir, sourceMapPath, {forHermes: true});
  console.log(`• compiling Hermes bytecode with ${path.relative(process.cwd(), compiler.hermesc) || compiler.hermesc}…`);
  let bytecode;
  let compileError = null;
  try {
    bytecode = buildBytecode(compiler, {contentsDir: sourceDir, sourcemapPath: sourceMapPath}, bundleFileName(platform));
  } catch (err) {
    compileError = err;
  }
  removeTemp(sourceDir);
  if (sourceMapPath) removeTemp(sourceMapPath);
  if (compileError) die(`${compileError.message}\nPass --no-hermes to release JavaScript instead. Nothing was uploaded.`);
  if (bytecode.sourcemapError) console.log(`⚠ bytecode source map not composed (${bytecode.sourcemapError}): crash stacks from bytecode won't show your source files`);
  const bytecodeHash = computePackageHash(bytecode.contentsDir);
  console.log(`• Hermes bytecode v${bytecode.bytecodeVersion}, hash ${bytecodeHash.slice(0, 12)}…; the minified JavaScript build above is its JavaScript copy`);
  return {
    contentsDir: bytecode.contentsDir,
    packageHash: bytecodeHash,
    localKey,
    sourcemapPath: bytecode.sourcemapPath,
    hermes: {bytecodeVersion: bytecode.bytecodeVersion},
    javascript: {contentsDir, packageHash, sourcemapPath},
  };
}

async function cmdRelease(args) {
  const [nameOrId, deployment = 'Staging'] = args;
  if (!nameOrId) die('Usage: pulsar release <app> <Staging|Production> --platform ios|android --target <ver> [--mandatory] [--disabled] [--rollout N] [--schedule +6h|ISO] [--ramp 100@48] [--from v6,ota,binary] [--devices id1,id2,...] [--device-models model1;model2] [--users u1,u2] [--private-key key.pem] [--bundle-key key.txt] [--plain-copy-for-old-builds | --plain | --only-older-builds] [--hermes | --no-hermes] [--no-diff] [--no-sourcemap] [--max-growth <percent>] [--description "..."]');
  if (!getFlag(args, 'target')) die('--target <binary version> is required (e.g. --target 1.0.0)');
  const app = await resolveApp(nameOrId, getFlag(args, 'platform', 'ios'));
  if (app.os !== getFlag(args, 'platform', 'ios')) {
    console.log(`• note: resolved app "${app.name}" is ${app.os}; bundling ${getFlag(args, 'platform', 'ios')}`);
  }
  await checkPrivateBeforeBuild([app], args);
  const compiler = hermesCompiler(args);
  const {contentsDir, packageHash, localKey, sourcemapPath, hermes, javascript} = buildOnce(args, compiler);
  await pushBuiltRelease(app, deployment, args, contentsDir, packageHash, localKey, {sourcemapPath, reachReported: true, hermes, javascript});
}

// Release the same built bundle to several apps at once (shared-codebase / white-label fleets).
async function cmdReleaseTrain(args) {
  const platform = getFlag(args, 'platform', 'ios');
  if (!getFlag(args, 'target')) die('--target <binary version> is required');
  const orgName = getFlag(args, 'org');
  const all = await api('/apps');
  let apps;
  let deployment;
  if (orgName) {
    deployment = args[0] && !args[0].startsWith('--') ? args[0] : 'Staging';
    const org = (await api('/orgs')).find((entry) => entry.name.toLowerCase() === orgName.toLowerCase());
    if (!org) die(`Organization not found: ${orgName}`);
    apps = all.filter((app) => app.orgId === org.id);
  } else {
    if (!args[0] || args[0].startsWith('--')) die('Usage: pulsar release-train <App1,App2,…|--org Name> <deployment> --platform ios|android --target <ver> [...release flags]');
    deployment = args[1] && !args[1].startsWith('--') ? args[1] : 'Staging';
    const names = args[0].split(',').map((name) => name.trim().toLowerCase());
    apps = all.filter((app) => names.includes(app.name.toLowerCase()) || names.includes(app.id));
  }
  apps = apps.filter((app) => app.os === platform);
  if (!apps.length) die(`No ${platform} apps matched.`);

  await checkPrivateBeforeBuild(apps, args);
  const compiler = hermesCompiler(args);
  const {contentsDir, packageHash, localKey, sourcemapPath, hermes, javascript} = buildOnce(args, compiler);
  console.log(`• release train → ${apps.length} app(s): ${apps.map((app) => app.name).join(', ')}`);
  for (const app of apps) {
    try {
      await pushBuiltRelease(app, deployment, args, contentsDir, packageHash, localKey, {sourcemapPath, reachReported: true, hermes, javascript});
    } catch (err) {
      console.log(`✗ ${app.name}: ${err.message}`);
    }
  }
}

const bytecodeTag = (release) => (release.hermes ? ` [bytecode v${release.hermes.bytecodeVersion}${release.jsCopy ? ' + JS copy' : ', no JS copy'}]` : '');

function warnMissingJsCopy(release) {
  if (!release?.hermes || release.jsCopy) return;
  const version = release.hermes.bytecodeVersion;
  console.log(`⚠ ${release.label} is Hermes bytecode v${version} without its JavaScript copy: only builds that run bytecode v${version} get it, every other build stays on its current release`);
}

async function cmdPromote(args) {
  const [nameOrId, from = 'Staging', to = 'Production'] = args;
  const app = await resolveApp(nameOrId, getFlag(args, 'platform'));
  const release = await api(`/apps/${app.id}/deployments/${from}/promote`, {
    method: 'POST',
    body: {to, rollout: Number(getFlag(args, 'rollout', '100'))},
  });
  console.log(`✓ promoted ${from} → ${to} as ${release.label}`);
  warnMissingJsCopy(release);
}

async function cmdRollback(args) {
  const [nameOrId, deployment = 'Production'] = args;
  const app = await resolveApp(nameOrId, getFlag(args, 'platform'));
  const release = await api(`/apps/${app.id}/deployments/${deployment}/rollback`, {method: 'POST'});
  console.log(`✓ rolled back ${app.name}/${deployment} → ${release.label}`);
  warnMissingJsCopy(release);
}

async function cmdDeployment(args) {
  const [sub, nameOrId, depName] = args;
  const app = await resolveApp(nameOrId, getFlag(args, 'platform'));
  if (sub === 'add') {
    if (!depName) die('Usage: pulsar deployment add <app> <name>');
    const created = await api(`/apps/${app.id}/deployments`, {method: 'POST', body: {name: depName}});
    console.log(`✓ added ${created.name}\n  key: ${shownKey(created)}`);
  } else if (sub === 'ls' || sub === 'list') {
    const full = await api(`/apps/${app.id}`);
    for (const [name, deployment] of Object.entries(full.deployments)) {
      console.log(`  ${name.padEnd(12)} ${shownKey(deployment)}`);
    }
  } else {
    die('Usage: pulsar deployment <add|ls> <app> [name]');
  }
}

async function cmdHistory(args) {
  const [nameOrId, deployment = 'Staging'] = args;
  const app = await resolveApp(nameOrId, getFlag(args, 'platform'));
  const releases = await api(`/apps/${app.id}/deployments/${deployment}/releases`);
  if (!releases.length) return console.log('(no releases)');
  for (const release of [...releases].reverse()) {
    const privacy = release.encrypted ? ` [private${release.plainCopy ? ' + plain copy' : ''}]` : release.olderBuildsOnly ? ' [plain, older builds only]' : release.plainOnPurpose ? ' [plain]' : '';
    const flags = `${release.isMandatory ? ' [mandatory]' : ''}${release.isDisabled ? ' [disabled]' : ''}${privacy}${bytecodeTag(release)}`;
    const rollout = release.currentRollout ?? release.rollout;
    const state = release.state && release.state !== 'live' ? ` [${release.state}]` : '';
    const when = release.startsAt ? ` starts ${new Date(release.startsAt).toLocaleString()}` : '';
    const ramping = release.rolloutRamp ? ` ->${release.rolloutRamp.to}%/${release.rolloutRamp.hours}h` : '';
    console.log(`  ${release.label.padEnd(5)} target ${String(release.appVersion).padEnd(10)} rollout ${String(rollout).padStart(3)}%${ramping}${flags}${state}${when}  ${release.description || ''}`);
  }
}

async function cmdPatch(args) {
  const [nameOrId, deployment, label] = args;
  if (!label) die('Usage: pulsar patch <app> <deployment> <label> [--rollout N] [--schedule +6h|ISO|none] [--ramp 100@48|none] [--from v6,ota,binary] [--mandatory] [--disable] [--enable] [--devices id1,id2,...] [--device-models model1;model2] [--users u1,u2]');
  const app = await resolveApp(nameOrId, getFlag(args, 'platform'));
  const body = {};
  const rollout = getFlag(args, 'rollout');
  if (rollout !== undefined) body.rollout = Number(rollout);
  if (args.includes('--mandatory')) body.isMandatory = true;
  if (args.includes('--disable')) body.isDisabled = true;
  if (args.includes('--enable')) body.isDisabled = false;
  const devices = getFlag(args, 'devices');
  if (devices !== undefined) body.clientIds = splitList(devices, ',');
  const deviceModels = getFlag(args, 'device-models');
  if (deviceModels !== undefined) body.targetDevices = splitList(deviceModels, ';');
  const users = getFlag(args, 'users');
  if (users !== undefined) body.targetUserIds = splitList(users, ',');
  const from = getFlag(args, 'from');
  if (from !== undefined) body.targetFromLabels = from === 'none' ? [] : splitList(from, ',');
  const schedule = getFlag(args, 'schedule');
  if (schedule !== undefined) body.startsAt = schedule === 'none' ? null : parseSchedule(schedule);
  const ramp = getFlag(args, 'ramp');
  if (ramp !== undefined) body.rolloutRamp = ramp === 'none' ? null : parseRamp(ramp);
  const release = await api(`/apps/${app.id}/deployments/${deployment}/releases/${label}`, {method: 'PATCH', body});
  console.log(`✓ patched ${label}: rollout ${release.rollout}%${release.rolloutRamp ? ` to ${release.rolloutRamp.to}% over ${release.rolloutRamp.hours}h` : ''}${release.startsAt ? ` starting ${new Date(release.startsAt).toLocaleString()}` : ''}${release.isMandatory ? ' mandatory' : ''}${release.isDisabled ? ' disabled' : ''}`);
}

// Deployment keys for a whole React Native project (its -Android and -iOS apps), shaped as the
// PULSAR_* env vars the mobile clients read. DEV maps to Staging, LIVE maps to Production.
const KEY_VAR = (platform, deployment) => `PULSAR_${platform.toUpperCase()}_${deployment === 'Production' ? 'LIVE' : 'DEV'}_KEY`;

async function cmdKeys(args) {
  const project = args.find((arg) => !arg.startsWith('--'));
  if (!project) die('Usage: pulsar keys <project> [--write <path/to/.env>] [--json]');
  const apps = await api('/apps');
  const matches = apps.filter((app) => app.name.toLowerCase().startsWith(`${project.toLowerCase()}-`));
  if (!matches.length) die(`No apps for project "${project}". Known: ${apps.map((app) => app.name).join(', ')}`);

  if (matches.some((app) => Object.values(app.deployments || {}).some((deployment) => !deployment.key))) die(HIDDEN_KEYS);
  const vars = {};
  for (const app of matches) {
    for (const deployment of ['Staging', 'Production']) {
      const key = app.deployments?.[deployment]?.key;
      if (key) vars[KEY_VAR(app.os, deployment)] = key;
    }
  }

  const target = getFlag(args, 'write');
  if (!target) {
    if (args.includes('--json')) return console.log(JSON.stringify(vars, null, 2));
    for (const [name, value] of Object.entries(vars)) console.log(`${name}=${value}`);
    return;
  }

  // Merge into the project's .env: update the PULSAR_* lines in place, append any that are
  // missing, and leave every other line (and every other secret) untouched.
  const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const lines = existing.split('\n');
  const written = new Set();
  const merged = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)(\s*=\s*)(.*)$/);
    if (!match || !(match[1] in vars)) return line;
    written.add(match[1]);
    return `${match[1]}${match[2]}${vars[match[1]]}`;
  });
  const missing = Object.keys(vars).filter((name) => !written.has(name));
  if (missing.length) {
    if (merged[merged.length - 1] !== '') merged.push('');
    merged.push('# Pulsar OTA keys (DEV = Staging deployment, LIVE = Production)');
    for (const name of missing) merged.push(`${name}=${vars[name]}`);
  }
  fs.writeFileSync(target, merged.join('\n'));
  console.log(`✓ wrote ${Object.keys(vars).length} key(s) to ${target} (${written.size} updated, ${missing.length} added)`);
}

export {saveConfig, browserLogin, signCodePushJWT, SIGNATURE_PATH, api, die, getFlag, loadConfig, pushBuiltRelease, splitList, resolveApp, growthChecks, buildOnce};

// Only dispatch when run as the CLI — importing the module (e.g. from tests) must not execute a command.
// Compare real paths: a global install runs through a bin symlink, so argv[1] is not this file's path.
function invokedAsCli() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  const [command, ...rest] = process.argv.slice(2);
  const commands = {
    login: cmdLogin,
    apps: cmdApps,
    release: cmdRelease,
    'release-train': cmdReleaseTrain,
    promote: cmdPromote,
    rollback: cmdRollback,
    deployment: cmdDeployment,
    history: cmdHistory,
    patch: cmdPatch,
    keygen: cmdKeygen,
    keys: cmdKeys,
    'bundle-key': cmdBundleKey,
    changes: cmdChanges,
    migrate,
  };

  const ANONYMOUS_COMMANDS = new Set(['login', 'keygen']);

  if (commands[command] && !ANONYMOUS_COMMANDS.has(command) && !loadConfig().token) {
    die('Not authenticated. Run: pulsar login <apiUrl>');
  }

  (commands[command] || (() => {
    console.log('pulsar <login|apps|keys|release|release-train|promote|rollback|deployment|history|patch|keygen|bundle-key|changes|migrate>');
    process.exit(command ? 1 : 0);
  }))(rest);
}
