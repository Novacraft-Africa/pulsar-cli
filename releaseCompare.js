const LIST_LIMIT = 200;

export function compareManifests(before, after) {
  const added = [];
  const removed = [];
  const modified = [];
  let unchanged = 0;
  for (const [filePath, entry] of Object.entries(after)) {
    const previous = before[filePath];
    if (!previous) added.push({path: filePath, size: entry.size});
    else if (previous.hash !== entry.hash) modified.push({path: filePath, before: previous.size, after: entry.size});
    else unchanged += 1;
  }
  for (const [filePath, entry] of Object.entries(before)) if (!after[filePath]) removed.push({path: filePath, size: entry.size});
  const total = (manifest) => Object.values(manifest).reduce((sum, entry) => sum + entry.size, 0);
  const bySize = (left, right) => (right.size ?? Math.abs(right.after - right.before)) - (left.size ?? Math.abs(left.after - left.before));
  return {
    added: added.sort(bySize).slice(0, LIST_LIMIT),
    removed: removed.sort(bySize).slice(0, LIST_LIMIT),
    modified: modified.sort(bySize).slice(0, LIST_LIMIT),
    counts: {added: added.length, removed: removed.length, modified: modified.length, unchanged},
    size: {before: total(before), after: total(after)},
  };
}

export const moduleName = (source) => {
  const text = String(source || '');
  const match = /(?:^|\/)(node_modules\/.*)$/.exec(text) || /(?:^|\/)(src\/.*)$/.exec(text);
  return match ? match[1] : text.replace(/^.*\/(?=[^/]+\/[^/]+$)/, '');
};

export function compareModules(beforeSources, afterSources) {
  const before = new Set((beforeSources || []).map(moduleName));
  const after = new Set((afterSources || []).map(moduleName));
  const added = [...after].filter((name) => !before.has(name));
  const removed = [...before].filter((name) => !after.has(name));
  return {added: added.slice(0, LIST_LIMIT), removed: removed.slice(0, LIST_LIMIT), counts: {added: added.length, removed: removed.length}};
}

export function manifestParts(document) {
  if (document?.files && typeof document.files === 'object' && !Array.isArray(document.files)) {
    return {files: document.files, modules: Array.isArray(document.modules) ? document.modules : null};
  }
  return {files: document || null, modules: null};
}
