import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

function isIgnored(relativePath) {
  const name = relativePath.split('/').pop();
  return (
    name === '.DS_Store' ||
    name === '.codepushrelease' ||
    relativePath.split('/').includes('__MACOSX')
  );
}

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

// Matches @revopush/react-native-code-push CodePushUpdateUtils.computeFinalHashFromManifest:
// build "relPath:sha256(file)" entries, sort, JSON.stringify the array, sha256 that string.
export function computePackageHash(contentsDir) {
  const entries = walk(contentsDir)
    .map((file) => {
      const relativePath = path.relative(contentsDir, file).split(path.sep).join('/');
      return {relativePath, hash: sha256(fs.readFileSync(file))};
    })
    .filter((entry) => !isIgnored(entry.relativePath))
    .map((entry) => `${entry.relativePath}:${entry.hash}`)
    .sort();

  return sha256(JSON.stringify(entries));
}
