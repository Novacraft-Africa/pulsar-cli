import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const SIGNAL_EXIT_CODES = {SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131, ...(process.platform === 'win32' ? {SIGBREAK: 149} : {})};
const tempPaths = new Set();
let cleanupInstalled = false;

export function removeTemp(tempPath) {
  fs.rmSync(tempPath, {recursive: true, force: true});
  tempPaths.delete(tempPath);
}

function removeAllTemp() {
  for (const tempPath of tempPaths) {
    try {
      removeTemp(tempPath);
    } catch {}
  }
}

function exitBySignal(signal) {
  removeAllTemp();
  process.removeAllListeners(signal);
  try {
    process.kill(process.pid, signal);
  } catch {}
  process.exit(SIGNAL_EXIT_CODES[signal]);
}

export function exitIfInterrupted(signal) {
  if (signal && Object.hasOwn(SIGNAL_EXIT_CODES, signal)) exitBySignal(signal);
}

export function execFileSyncInterruptible(file, args, options) {
  try {
    return execFileSync(file, args, options);
  } catch (err) {
    exitIfInterrupted(err.signal);
    throw err;
  }
}

function installCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.on('exit', removeAllTemp);
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) process.on(signal, () => exitBySignal(signal));
}

export function trackTemp(tempPath) {
  installCleanup();
  tempPaths.add(tempPath);
  return tempPath;
}

export const makeTempDir = (prefix) => trackTemp(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
