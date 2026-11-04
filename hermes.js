import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {walk} from './hash.js';
import {exitIfInterrupted, makeTempDir, removeTemp, trackTemp} from './temp.js';

const MAGIC = Buffer.from('c61fbc03c103191f', 'hex');
const HEADER_LENGTH = 12;
const OS_DIRS = {darwin: 'osx-bin', linux: 'linux64-bin', win32: 'win64-bin'};
const COMPILER_DIRS = [['hermes-compiler', 'hermesc'], ['react-native', 'sdks', 'hermesc'], ['hermes-engine']];
const COMPOSE_SCRIPT = ['react-native', 'scripts', 'compose-source-maps.js'];
const DIAGNOSTIC_LINES = 20;
const BUNDLE_FILES = [/(^|\/)(main\.jsbundle|index\.android\.bundle)$/, /(^|\/)[^/]+\.(jsbundle|bundle)$/];

export const bundleFileName = (platform) => (platform === 'ios' ? 'main.jsbundle' : 'index.android.bundle');

export function bytecodeVersionOf(bytes) {
  if (!bytes || bytes.length < HEADER_LENGTH) return null;
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, HEADER_LENGTH);
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) return null;
  return head.readUInt32LE(MAGIC.length);
}

export function fileBytecodeVersion(filePath) {
  const handle = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(HEADER_LENGTH);
    return bytecodeVersionOf(head.subarray(0, fs.readSync(handle, head, 0, HEADER_LENGTH, 0)));
  } finally {
    fs.closeSync(handle);
  }
}

export function bundleBytecodeIn(contentsDir) {
  const files = walk(contentsDir).map((file) => path.relative(contentsDir, file).split(path.sep).join('/'));
  for (const pattern of BUNDLE_FILES) {
    const bundle = files.find((file) => pattern.test(file));
    if (bundle) return fileBytecodeVersion(path.join(contentsDir, bundle));
  }
  return null;
}

const readText = (filePath) => (fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '');
const uncommented = (text, commentPattern) => text.split(/\r?\n/).filter((line) => !commentPattern.test(line));

export function hermesEnabledIn(projectRoot, platform) {
  if (platform === 'android') {
    const properties = uncommented(readText(path.join(projectRoot, 'android', 'gradle.properties')), /^\s*[#!]/);
    const appGradle = uncommented(readText(path.join(projectRoot, 'android', 'app', 'build.gradle')), /^\s*\/\//);
    return !properties.some((line) => /^\s*hermesEnabled\s*[=:]\s*false\s*$/.test(line))
      && !appGradle.some((line) => /^[^/]*\benableHermes\s*[:=]\s*false\b/.test(line));
  }
  const podfile = uncommented(readText(path.join(projectRoot, 'ios', 'Podfile')), /^\s*#/);
  return !podfile.some((line) => /(?::hermes_enabled\s*=>|\bhermes_enabled:)\s*false\b/.test(line));
}

function findInNodeModules(projectRoot, candidates) {
  let directory = path.resolve(projectRoot);
  for (;;) {
    for (const parts of candidates) {
      const candidate = path.join(directory, 'node_modules', ...parts);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function findHermesc(projectRoot, osName = process.platform) {
  const osDir = OS_DIRS[osName];
  if (!osDir) return null;
  const binary = osName === 'win32' ? 'hermesc.exe' : 'hermesc';
  return findInNodeModules(projectRoot, COMPILER_DIRS.map((parts) => [...parts, osDir, binary]));
}

export const findComposeScript = (projectRoot) => findInNodeModules(projectRoot, [COMPOSE_SCRIPT]);

export function hermesChoice(args, projectRoot, platform) {
  if (args.includes('--hermes') && args.includes('--no-hermes')) return {error: 'pass --hermes or --no-hermes, not both'};
  if (args.includes('--no-hermes')) return {enabled: false};
  return {enabled: args.includes('--hermes') || hermesEnabledIn(projectRoot, platform)};
}

function diagnostics(output) {
  const lines = String(output || '').split('\n').filter(Boolean);
  const errors = lines.filter((line) => /\berror:/.test(line));
  return (errors.length ? errors : lines).slice(0, DIAGNOSTIC_LINES).join('\n');
}

export function compileBytecode(hermesc, inputPath, outputPath, {sourcemap = false} = {}) {
  const result = spawnSync(
    hermesc,
    ['-emit-binary', '-max-diagnostic-width=80', '-O', ...(sourcemap ? ['-output-source-map'] : []), '-out', outputPath, inputPath],
    {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024},
  );
  exitIfInterrupted(result.signal);
  if (result.error) throw new Error(`could not run ${hermesc}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`hermesc failed:\n${diagnostics(result.stderr || result.stdout)}`);
  const bytecodeVersion = fs.existsSync(outputPath) ? fileBytecodeVersion(outputPath) : null;
  if (!bytecodeVersion) throw new Error('hermesc finished, but what it wrote is not Hermes bytecode');
  const sourcemapPath = `${outputPath}.map`;
  return {bytecodeVersion, sourcemapPath: sourcemap && fs.existsSync(sourcemapPath) ? sourcemapPath : null};
}

export function composeSourcemaps(composeScript, packagerMapPath, compilerMapPath, outputPath) {
  const result = spawnSync(process.execPath, [composeScript, packagerMapPath, compilerMapPath, '-o', outputPath], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  exitIfInterrupted(result.signal);
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0 || !fs.existsSync(outputPath)) throw new Error(diagnostics(result.stderr) || `exit code ${result.status}`);
}

export function buildBytecode({hermesc, composeScript}, javascript, bundleName) {
  const compilerDir = makeTempDir('pulsar-hermesc-');
  try {
    const compiledPath = path.join(compilerDir, bundleName);
    const compiled = compileBytecode(hermesc, path.join(javascript.contentsDir, bundleName), compiledPath, {sourcemap: Boolean(javascript.sourcemapPath)});
    const contentsDir = makeTempDir('pulsar-bytecode-');
    fs.cpSync(javascript.contentsDir, contentsDir, {recursive: true});
    fs.copyFileSync(compiledPath, path.join(contentsDir, bundleName));
    let sourcemapPath = null;
    let sourcemapError = null;
    if (compiled.sourcemapPath) {
      try {
        if (!composeScript) throw new Error('react-native/scripts/compose-source-maps.js was not found in node_modules');
        composeSourcemaps(composeScript, javascript.sourcemapPath, compiled.sourcemapPath, trackTemp(`${contentsDir}.map`));
        sourcemapPath = `${contentsDir}.map`;
      } catch (err) {
        sourcemapError = err.message;
      }
    }
    return {contentsDir, bytecodeVersion: compiled.bytecodeVersion, sourcemapPath, sourcemapError};
  } finally {
    removeTemp(compilerDir);
  }
}
