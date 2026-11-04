import fs from 'node:fs';
import path from 'node:path';
import {api, die, getFlag, loadConfig, pushBuiltRelease, splitList} from './pulsar.js';
import {computePackageHash} from './hash.js';
import {bundleBytecodeIn} from './hermes.js';
import {execFileSyncInterruptible, makeTempDir, removeTemp} from './temp.js';

const USAGE = 'Usage: pulsar migrate --from <serverUrl> --access-key <key> [--apps A,B] [--org <name>] [--platform ios|android] [--releases latest|none] [--dry-run]';

async function sourceGet(source, pathname) {
  const response = await fetch(source.url + pathname, {
    headers: {authorization: `Bearer ${source.accessKey}`, accept: 'application/vnd.code-push.v2+json'},
  });
  if (!response.ok) throw new Error(`GET ${pathname} → ${response.status} ${response.statusText}`);
  return response.json();
}

function platformOf(sourceApp, fallback) {
  const declared = String(sourceApp.os || '').toLowerCase();
  if (declared === 'ios' || declared === 'android') return declared;
  if (/android/i.test(sourceApp.name)) return 'android';
  if (/(^|[^a-z])ios([^a-z]|$)/i.test(sourceApp.name)) return 'ios';
  return fallback;
}

async function chooseOrg(orgName) {
  const orgs = await api('/orgs');
  if (orgName) {
    const match = orgs.find((org) => org.name.toLowerCase() === orgName.toLowerCase());
    if (!match) die(`Organization not found: ${orgName}. Known: ${orgs.map((org) => org.name).join(', ') || '(none)'}`);
    return match;
  }
  if (orgs.length === 1) return orgs[0];
  die(`Pass --org <name> to choose where the apps go. Known: ${orgs.map((org) => org.name).join(', ') || '(none)'}`);
}

async function migrateRelease({source, pulsarApp, deploymentName, sourcePackage, dryRun}) {
  if (!sourcePackage) return 'no release on source';
  if (!sourcePackage.appVersion) return `not migrated: ${sourcePackage.label} has no target app version`;
  if (dryRun) return `would re-release ${sourcePackage.label} (target ${sourcePackage.appVersion})`;
  const workDir = makeTempDir('pulsar-migrate-');
  const zipPath = path.join(workDir, 'source.zip');
  const contentsDir = path.join(workDir, 'contents');
  try {
    const response = await fetch(new URL(sourcePackage.blobUrl, source.url)).catch((err) => {
      throw new Error(`download failed (${err.message})`);
    });
    if (!response.ok) throw new Error(`download failed (${response.status})`);
    fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));
    try {
      execFileSyncInterruptible('unzip', ['-qq', '-o', zipPath, '-d', contentsDir], {stdio: 'pipe'});
    } catch {
      throw new Error('downloaded bundle is not a readable zip');
    }
    const bytecodeVersion = bundleBytecodeIn(contentsDir);
    if (bytecodeVersion) return `not migrated: ${sourcePackage.label} is Hermes bytecode v${bytecodeVersion}; release it again from source with pulsar release`;
    const packageHash = computePackageHash(contentsDir);
    const existing = await api(`/apps/${pulsarApp.id}/deployments/${deploymentName}/releases`);
    const already = existing.find((entry) => entry.packageHash === packageHash);
    if (already) return `${sourcePackage.label} already on Pulsar as ${already.label}`;

    const releaseArgs = [
      '--target', sourcePackage.appVersion,
      '--description', sourcePackage.description || '',
      '--rollout', String(sourcePackage.rollout ?? 100),
      ...(sourcePackage.isMandatory ? ['--mandatory'] : []),
      ...(sourcePackage.isDisabled ? ['--disabled'] : []),
    ];
    const localKey = (process.env.PULSAR_SIGNING_KEY || '').trim();
    const release = await pushBuiltRelease(pulsarApp, deploymentName, releaseArgs, contentsDir, packageHash, localKey);
    const notes = [
      sourcePackage.packageHash && sourcePackage.packageHash !== packageHash ? 're-hashed: source hash differed' : null,
      release.signed === false ? 'UNSIGNED, blocked until an org owner approves it' : null,
      release.isDisabled ? 'disabled' : null,
    ].filter(Boolean);
    return `${sourcePackage.label} → ${release.label}${notes.length ? ` (${notes.join('; ')})` : ''}`;
  } catch (err) {
    return `not migrated: ${err.message}`;
  } finally {
    removeTemp(workDir);
  }
}

async function migrateApp({source, sourceApp, org, pulsarApps, args, dryRun, rows}) {
  const name = sourceApp.name.split(':').pop();
  const platform = platformOf(sourceApp, getFlag(args, 'platform'));
  const skipRow = (reason) => rows.push({app: name, deployment: '-', sourceKey: '-', pulsarKey: '-', release: reason});
  if (!platform) return skipRow('skipped: platform unknown, pass --platform ios|android');

  let deployments;
  try {
    ({deployments} = await sourceGet(source, `/apps/${encodeURIComponent(sourceApp.name)}/deployments`));
  } catch (err) {
    return skipRow(`skipped: ${err.message}`);
  }

  let pulsarApp = pulsarApps.find((app) => app.orgId === org.id && app.name === name && app.os === platform);
  if (pulsarApp) console.log(`• ${name} [${platform}]: reusing the existing Pulsar app`);
  else if (dryRun) console.log(`• ${name} [${platform}]: would create in ${org.name}`);
  else {
    pulsarApp = await api('/apps', {method: 'POST', body: {name, os: platform, orgId: org.id}});
    console.log(`• ${name} [${platform}]: created in ${org.name}`);
  }

  for (const {name: deploymentName} of deployments) {
    const row = {app: `${name} [${platform}]`, deployment: deploymentName, sourceKey: '-', pulsarKey: '-', release: ''};
    rows.push(row);
    let sourceDeployment;
    try {
      ({deployment: sourceDeployment} = await sourceGet(
        source,
        `/apps/${encodeURIComponent(sourceApp.name)}/deployments/${encodeURIComponent(deploymentName)}`,
      ));
    } catch (err) {
      row.release = `not migrated: ${err.message}`;
      continue;
    }
    row.sourceKey = sourceDeployment.key || '-';

    const existingDeployment = pulsarApp?.deployments?.[deploymentName];
    if (existingDeployment && !existingDeployment.key) throw new Error('Deployment keys are hidden for this login. Run "pulsar login" again, then retry.');
    row.pulsarKey = existingDeployment?.key;
    if (!row.pulsarKey && dryRun) row.pulsarKey = '(new)';
    else if (!row.pulsarKey) {
      ({key: row.pulsarKey} = await api(`/apps/${pulsarApp.id}/deployments`, {method: 'POST', body: {name: deploymentName}}));
      console.log(`  added deployment ${deploymentName}`);
    }

    row.release = getFlag(args, 'releases', 'latest') === 'none'
      ? 'skipped (--releases none)'
      : await migrateRelease({source, pulsarApp, deploymentName, sourcePackage: sourceDeployment.package, dryRun});
  }
}

function printSummary(rows) {
  const columns = [['app', 'App'], ['deployment', 'Deployment'], ['sourceKey', 'Source key'], ['pulsarKey', 'Pulsar key'], ['release', 'Release']];
  const widths = columns.map(([field, title]) => Math.max(title.length, ...rows.map((row) => String(row[field]).length)));
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ').trimEnd();
  console.log(`\n${line(columns.map(([, title]) => title))}`);
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of rows) console.log(line(columns.map(([field]) => row[field])));
}

function printRebuildReminder(serverUrl) {
  console.log(`
Devices keep checking the old server until each app is rebuilt with its new Pulsar key and server URL.

  iOS — Info.plist:
    <key>CodePushDeploymentKey</key>
    <string>PULSAR_KEY_FROM_TABLE</string>
    <key>CodePushServerURL</key>
    <string>${serverUrl}</string>

  Android — android/app/src/main/res/values/strings.xml:
    <string moduleConfig="true" name="CodePushDeploymentKey">PULSAR_KEY_FROM_TABLE</string>
    <string moduleConfig="true" name="CodePushServerUrl">${serverUrl}</string>`);
}

export async function migrate(args) {
  const from = getFlag(args, 'from');
  const accessKey = getFlag(args, 'access-key');
  if (!from || !accessKey) die(USAGE);
  const releasesMode = getFlag(args, 'releases', 'latest');
  if (!['latest', 'none'].includes(releasesMode)) die(`--releases must be latest or none\n${USAGE}`);
  const dryRun = args.includes('--dry-run');
  const source = {url: from.replace(/\/$/, ''), accessKey};

  const {apps: sourceApps = []} = await sourceGet(source, '/apps').catch((err) => die(`Could not list apps on ${from}: ${err.message}`));
  const wanted = splitList(getFlag(args, 'apps'), ',');
  const selected = wanted.length ? sourceApps.filter((app) => wanted.includes(app.name) || wanted.includes(app.name.split(':').pop())) : sourceApps;
  const unmatched = wanted.filter((wantedName) => !selected.some((app) => app.name === wantedName || app.name.split(':').pop() === wantedName));
  if (unmatched.length) console.log(`⚠ not on the source server: ${unmatched.join(', ')}`);
  if (!selected.length) die(`No apps to migrate. Source has: ${sourceApps.map((app) => app.name).join(', ') || '(none)'}`);

  const org = await chooseOrg(getFlag(args, 'org'));
  const pulsarApps = await api('/apps');
  console.log(`${dryRun ? 'DRY RUN — nothing will be written to Pulsar.\n' : ''}Migrating ${selected.length} app(s) from ${source.url} into ${org.name}`);

  const rows = [];
  for (const sourceApp of selected) {
    await migrateApp({source, sourceApp, org, pulsarApps, args, dryRun, rows});
  }
  printSummary(rows);
  printRebuildReminder(loadConfig().apiUrl);
}
