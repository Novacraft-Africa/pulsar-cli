#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {execFileSync} from 'node:child_process';
import {computePackageHash} from './hash.js';

const CONFIG_DIR = path.join(os.homedir(), '.pulsar');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  const fromFile = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
  return {
    apiUrl: process.env.PULSAR_API_URL || fromFile.apiUrl,
    token: process.env.PULSAR_TOKEN || fromFile.token,
  };
}

function saveConfig(config) {
  fs.mkdirSync(CONFIG_DIR, {recursive: true});
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function api(pathname, {method = 'GET', body, headers = {}, raw} = {}) {
  const {apiUrl, token} = loadConfig();
  if (!apiUrl) die('No API url. Run: pulsar login <apiUrl>');
  const response = await fetch(apiUrl.replace(/\/$/, '') + pathname, {
    method,
    headers: {
      ...(token ? {authorization: `Bearer ${token}`} : {}),
      ...(raw ? {} : body ? {'content-type': 'application/json'} : {}),
      ...headers,
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) die(`${response.status}: ${data.error || text}`);
  return data;
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

async function resolveApp(nameOrId) {
  const apps = await api('/apps');
  const match = apps.find((app) => app.id === nameOrId || app.name === nameOrId);
  if (!match) die(`App not found: ${nameOrId}. Known: ${apps.map((app) => app.name).join(', ') || '(none)'}`);
  return match;
}

function bundle(platform, contentsDir) {
  const bundleName = platform === 'ios' ? 'main.jsbundle' : 'index.android.bundle';
  fs.mkdirSync(contentsDir, {recursive: true});
  console.log(`• bundling ${platform}…`);
  execFileSync(
    'npx',
    [
      'react-native',
      'bundle',
      '--platform', platform,
      '--dev', 'false',
      '--entry-file', 'index.js',
      '--bundle-output', path.join(contentsDir, bundleName),
      '--assets-dest', contentsDir,
    ],
    {stdio: 'inherit'},
  );
}

function zipContents(contentsDir) {
  const zipPath = path.join(os.tmpdir(), `pulsar-${Date.now()}.zip`);
  execFileSync('zip', ['-qq', '-r', '-X', zipPath, '.'], {cwd: contentsDir});
  return zipPath;
}

function getFlag(args, name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

async function cmdLogin(args) {
  const apiUrl = args[0] || (await prompt('API url: '));
  const email = await prompt('Email: ');
  const password = await prompt('Password: ', true);
  saveConfig({apiUrl, token: undefined});
  const {token, user} = await api('/auth/login', {method: 'POST', body: {email, password}});
  saveConfig({apiUrl, token});
  console.log(`✓ logged in as ${user.email} (${user.platformRole})`);
}

async function cmdApps() {
  const apps = await api('/apps');
  if (!apps.length) return console.log('(no apps)');
  for (const app of apps) {
    console.log(`\n${app.name}  [${app.os}]  ${app.id}`);
    for (const [name, deployment] of Object.entries(app.deployments)) {
      console.log(`  ${name.padEnd(11)} key: ${deployment.key}`);
    }
  }
}

async function cmdRelease(args) {
  const [nameOrId, deployment = 'Staging'] = args;
  if (!nameOrId) die('Usage: pulsar release <app> <Staging|Production> --platform ios|android --target <ver> [--mandatory] [--rollout N] [--description "..."]');
  const platform = getFlag(args, 'platform', 'ios');
  const target = getFlag(args, 'target');
  if (!target) die('--target <binary version> is required (e.g. --target 1.0.0)');

  const app = await resolveApp(nameOrId);
  const contentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-build-'));
  bundle(platform, contentsDir);

  const packageHash = computePackageHash(contentsDir);
  const zipPath = zipContents(contentsDir);
  const zip = fs.readFileSync(zipPath);
  console.log(`• hash ${packageHash.slice(0, 12)}…  size ${(zip.length / 1e6).toFixed(2)} MB`);

  const release = await api(`/apps/${app.id}/deployments/${deployment}/release`, {
    method: 'POST',
    raw: true,
    body: zip,
    headers: {
      'content-type': 'application/zip',
      'x-app-version': target,
      'x-package-hash': packageHash,
      'x-is-mandatory': String(args.includes('--mandatory')),
      'x-rollout': String(getFlag(args, 'rollout', '100')),
      'x-description': getFlag(args, 'description', ''),
    },
  });
  console.log(`✓ released ${release.label} to ${app.name}/${deployment}`);
}

async function cmdPromote(args) {
  const [nameOrId, from = 'Staging', to = 'Production'] = args;
  const app = await resolveApp(nameOrId);
  const release = await api(`/apps/${app.id}/deployments/${from}/promote`, {
    method: 'POST',
    body: {to, rollout: Number(getFlag(args, 'rollout', '100'))},
  });
  console.log(`✓ promoted ${from} → ${to} as ${release.label}`);
}

async function cmdRollback(args) {
  const [nameOrId, deployment = 'Production'] = args;
  const app = await resolveApp(nameOrId);
  const release = await api(`/apps/${app.id}/deployments/${deployment}/rollback`, {method: 'POST'});
  console.log(`✓ rolled back ${app.name}/${deployment} → ${release.label}`);
}

async function cmdDeployment(args) {
  const [sub, nameOrId, depName] = args;
  const app = await resolveApp(nameOrId);
  if (sub === 'add') {
    if (!depName) die('Usage: pulsar deployment add <app> <name>');
    const created = await api(`/apps/${app.id}/deployments`, {method: 'POST', body: {name: depName}});
    console.log(`✓ added ${created.name}\n  key: ${created.key}`);
  } else if (sub === 'ls' || sub === 'list') {
    const full = await api(`/apps/${app.id}`);
    for (const [name, deployment] of Object.entries(full.deployments)) {
      console.log(`  ${name.padEnd(12)} ${deployment.key}`);
    }
  } else {
    die('Usage: pulsar deployment <add|ls> <app> [name]');
  }
}

async function cmdHistory(args) {
  const [nameOrId, deployment = 'Staging'] = args;
  const app = await resolveApp(nameOrId);
  const releases = await api(`/apps/${app.id}/deployments/${deployment}/releases`);
  if (!releases.length) return console.log('(no releases)');
  for (const release of [...releases].reverse()) {
    const flags = `${release.isMandatory ? ' [mandatory]' : ''}${release.isDisabled ? ' [disabled]' : ''}`;
    console.log(`  ${release.label.padEnd(5)} target ${String(release.appVersion).padEnd(10)} rollout ${String(release.rollout).padStart(3)}%${flags}  ${release.description || ''}`);
  }
}

async function cmdPatch(args) {
  const [nameOrId, deployment, label] = args;
  if (!label) die('Usage: pulsar patch <app> <deployment> <label> [--rollout N] [--mandatory] [--disable] [--enable]');
  const app = await resolveApp(nameOrId);
  const body = {};
  const rollout = getFlag(args, 'rollout');
  if (rollout !== undefined) body.rollout = Number(rollout);
  if (args.includes('--mandatory')) body.isMandatory = true;
  if (args.includes('--disable')) body.isDisabled = true;
  if (args.includes('--enable')) body.isDisabled = false;
  const release = await api(`/apps/${app.id}/deployments/${deployment}/releases/${label}`, {method: 'PATCH', body});
  console.log(`✓ patched ${label}: rollout ${release.rollout}%${release.isMandatory ? ' mandatory' : ''}${release.isDisabled ? ' disabled' : ''}`);
}

const [command, ...rest] = process.argv.slice(2);
const commands = {
  login: cmdLogin,
  apps: cmdApps,
  release: cmdRelease,
  promote: cmdPromote,
  rollback: cmdRollback,
  deployment: cmdDeployment,
  history: cmdHistory,
  patch: cmdPatch,
};

(commands[command] || (() => {
  console.log('pulsar <login|apps|release|promote|rollback|deployment|history|patch>');
  process.exit(command ? 1 : 0);
}))(rest);
