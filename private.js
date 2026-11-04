import fs from 'node:fs';
import path from 'node:path';
import {api, die, getFlag, loadConfig, resolveApp} from './pulsar.js';
import {seal, open, parseKeys, generateKeyString, SEALED_CONTENT_TYPE} from './envelope.js';
import {compareManifests, compareModules, manifestParts} from './releaseCompare.js';

export async function loadBundleKeys(args) {
  const keyFile = getFlag(args, 'bundle-key');
  if (keyFile && !fs.existsSync(keyFile)) die(`no bundle key file at ${keyFile}`);
  const keyString = keyFile ? fs.readFileSync(keyFile, 'utf8') : (process.env.PULSAR_BUNDLE_KEY || '').trim();
  if (!keyString) return [];
  try {
    return await parseKeys(keyString);
  } catch (err) {
    die(`bundle key: ${err.message}`);
  }
}

export async function privateContext(app, args, localKey) {
  let settings;
  try {
    settings = await api(`/apps/${app.id}/private-bundles`, {optional: true});
  } catch (err) {
    if (!err.status) die(`couldn't check whether ${app.name} uses private bundles (${[err.message, err.cause?.code].filter(Boolean).join(', ')}). Nothing was uploaded.`);
    return null;
  }
  if (!settings || settings.mode === 'off') return null;
  if (!localKey) die(`${app.name} uses private bundles, which need local signing: pass --private-key <file> or set PULSAR_SIGNING_KEY. Nothing was uploaded.`);
  const plain = args.includes('--only-older-builds') ? 'older' : args.includes('--plain') ? 'all' : null;
  if (plain && args.includes('--plain-copy-for-old-builds')) die('--plain-copy-for-old-builds goes with an encrypted release; drop it when releasing plain. Nothing was uploaded.');
  const given = await loadBundleKeys(args);
  const registered = new Set(settings.keys.map((entry) => entry.kid));
  const keys = given.filter((key) => registered.has(key.kid));
  if (plain) return {keys, readiness: settings.readiness, plain};
  if (!given.length) die(`${app.name} uses private bundles: pass --bundle-key <file> or set PULSAR_BUNDLE_KEY, or release plain on purpose with --plain or --only-older-builds. Nothing was uploaded.`);
  if (!keys.length) die(`none of your bundle keys (${given.map((key) => key.kid).join(', ')}) are registered for ${app.name}. Registered: ${[...registered].join(', ') || 'none'}`);
  const missing = [...registered].filter((kid) => !keys.some((key) => key.kid === kid));
  if (missing.length) console.log(`⚠ registered key ${missing.join(', ')} wasn't given, so builds holding only that key won't get this release`);
  return {keys, readiness: settings.readiness, plain: null};
}

export function reportReach(context, {mandatory, plainCopy}) {
  const {total = 0, ready = 0, windowDays = 30} = context.readiness || {};
  const left = total - ready;
  if (context.plain === 'all') {
    console.log(`• plain release on purpose: reaches all ${total} devices seen in the last ${windowDays} days, and Pulsar can read it`);
    return;
  }
  if (context.plain === 'older') {
    console.log(`• plain release for older builds only: reaches the ${left} of ${total} devices that can't open private releases; Pulsar can read it. The ${ready} that can keep their encrypted release`);
    if (mandatory && left === 0) die('every recent device can open private releases, so an older-builds-only release would reach nobody. Nothing was uploaded.');
    return;
  }
  if (plainCopy) {
    console.log(`• private release: ${ready} of ${total} devices seen in the last ${windowDays} days get the encrypted copy; ${left} get the plain copy for older builds, which Pulsar can read`);
    return;
  }
  console.log(`• private release: reaches ${ready} of ${total} devices seen in the last ${windowDays} days; ${left} stay on their current bundle`);
  if (mandatory && ready === 0) {
    die('no device can open private releases yet, so a mandatory one would reach nobody. Ship store builds with SDK 1.8 and the bundle key, or add --plain-copy-for-old-builds. Nothing was uploaded.');
  }
}

export const sealArtifact = (context, app, packageHash, plaintext, kind, extra = {}) =>
  seal({plaintext: new Uint8Array(plaintext), keys: context.keys, appId: app.id, packageHash, kind, ...extra});

export async function openArtifact(keys, bytes, expected) {
  return Buffer.from((await open(new Uint8Array(bytes), keys, expected)).plaintext);
}

export const sealedHeaders = {'content-type': SEALED_CONTENT_TYPE};

async function cmdBundleKeyCreate(args) {
  const appName = getFlag(args, 'app');
  if (!appName) die('Usage: pulsar bundle-key create --app <name> [--out <file>] [--platform ios|android]');
  const app = await resolveApp(appName, getFlag(args, 'platform'));
  const outFile = getFlag(args, 'out', `pulsar-bundle-key-${app.name.replace(/[^A-Za-z0-9._-]+/g, '-')}.txt`);
  if (fs.existsSync(outFile)) die(`${outFile} already exists. Pick another --out; never overwrite a bundle key.`);
  const keyString = await generateKeyString();
  const [{kid}] = await parseKeys(keyString);
  fs.writeFileSync(outFile, `${keyString}\n`, {mode: 0o600, flag: 'wx'});
  console.log(`✓ wrote bundle key ${kid} to ${path.resolve(outFile)} (owner-only)`);
  try {
    await api(`/apps/${app.id}/private-bundles`, {method: 'PUT', body: {addKids: [kid]}, optional: true});
    console.log(`✓ registered key id ${kid} with ${app.name}`);
  } catch (err) {
    console.log(`⚠ couldn't register the key id (${err.message}). An admin can add ${kid} under Private bundles in the dashboard.`);
  }
  console.log('\nBack this file up now (password manager or secrets vault). If it is lost, builds that carry only this key can\'t receive updates until a new store build ships.');
  console.log('\nCI: set PULSAR_BUNDLE_KEY to the file\'s contents.');
  console.log('\niOS Info.plist:');
  console.log(`  <key>CodePushBundleKeys</key>\n  <string>${keyString}</string>`);
  console.log('\nAndroid res/values/strings.xml:');
  console.log(`  <string moduleConfig="true" name="CodePushBundleKeys">${keyString}</string>`);
}

async function cmdBundleKeyId(args) {
  const keys = await loadBundleKeys(args);
  if (!keys.length) die('pass --bundle-key <file> or set PULSAR_BUNDLE_KEY');
  for (const key of keys) console.log(key.kid);
}

export async function cmdBundleKey(args) {
  const [sub, ...rest] = args;
  if (sub === 'create') return cmdBundleKeyCreate(rest);
  if (sub === 'id') return cmdBundleKeyId(rest);
  die('Usage: pulsar bundle-key <create|id> [--app <name>] [--bundle-key <file>]');
}

async function fetchSealed(app, deployment, label, kind) {
  const {apiUrl, token} = loadConfig();
  const response = await fetch(`${apiUrl.replace(/\/$/, '')}/apps/${app.id}/deployments/${deployment}/releases/${label}/sealed/${kind}`, {headers: {authorization: `Bearer ${token}`}});
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

export async function cmdChanges(args) {
  const appName = getFlag(args, 'app');
  const deployment = getFlag(args, 'deployment', 'Staging');
  const label = getFlag(args, 'label');
  if (!appName || !label) die('Usage: pulsar changes --app <name> --deployment <Staging|Production> --label <vN> [--base <vM>] [--bundle-key <file>]');
  const app = await resolveApp(appName, getFlag(args, 'platform'));
  const base = getFlag(args, 'base');
  const summary = await api(`/apps/${app.id}/deployments/${deployment}/releases/${label}/changes${base ? `?base=${encodeURIComponent(base)}` : ''}`);
  if (!summary.base) return console.log(`${label} has nothing earlier to compare with.`);
  let files = summary.files;
  let modules = summary.modules;
  if (summary.sealed) {
    const keys = await loadBundleKeys(args);
    if (!keys.length) die('this release is private: pass --bundle-key <file> or set PULSAR_BUNDLE_KEY to unlock it here');
    const releases = await api(`/apps/${app.id}/deployments/${deployment}/releases`);
    const hashOf = (wanted) => releases.find((entry) => entry.label === wanted)?.packageHash;
    const unlock = async (wanted, kind) => {
      const bytes = await fetchSealed(app, deployment, wanted, kind);
      if (!bytes) return null;
      return JSON.parse((await openArtifact(keys, bytes, {appId: app.id, packageHash: hashOf(wanted), kind})).toString('utf8'));
    };
    const [before, after] = (await Promise.all([unlock(summary.base, 'manifest'), unlock(summary.target, 'manifest')])).map(manifestParts);
    files = before.files && after.files ? compareManifests(before.files, after.files) : null;
    let beforeModules = before.modules;
    let afterModules = after.modules;
    if (!beforeModules || !afterModules) {
      const [beforeMap, afterMap] = await Promise.all([unlock(summary.base, 'sourcemap'), unlock(summary.target, 'sourcemap')]);
      beforeModules = beforeMap?.sources || null;
      afterModules = afterMap?.sources || null;
    }
    modules = beforeModules && afterModules ? compareModules(beforeModules, afterModules) : null;
  }
  console.log(`${summary.target} compared with ${summary.base}${summary.sealed ? ' (unlocked on this machine)' : ''}`);
  if (!files && !modules) return console.log('No file list or source map was uploaded for one of these releases.');
  if (files) {
    console.log(`  files: ${files.counts.added} added, ${files.counts.modified} modified, ${files.counts.removed} removed, ${files.counts.unchanged} unchanged`);
    for (const entry of files.added) console.log(`  + ${entry.path}`);
    for (const entry of files.modified) console.log(`  ~ ${entry.path}`);
    for (const entry of files.removed) console.log(`  - ${entry.path}`);
  }
  if (modules) {
    console.log(`  modules: ${modules.counts.added} added, ${modules.counts.removed} removed`);
    for (const name of modules.added) console.log(`  + ${name}`);
    for (const name of modules.removed) console.log(`  - ${name}`);
  }
}
