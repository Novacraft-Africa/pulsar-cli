const MAGIC = [0x50, 0x4c, 0x53, 0x42];
const VERSION = 1;
const PREFIX_LENGTH = 9;
const MAX_HEADER = 16384;
export const SEGMENT_SIZE = 65536;
const TAG_LENGTH = 16;
export const ALGORITHM = 'A256GCM-SEG64K';
export const KINDS = ['full', 'diff', 'manifest', 'sourcemap'];
export const SEALED_CONTENT_TYPE = 'application/vnd.pulsar.sealed';

const KID_PATTERN = /^[0-9a-f]{16}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;

export function toBase64(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let offset = 0; offset < view.length; offset += 0x8000) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(String(text));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const toHex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export async function kidOf(rawKey) {
  const digest = new Uint8Array(await subtle().digest('SHA-256', rawKey));
  return toHex(digest.subarray(0, 8));
}

export async function generateKeyString() {
  const raw = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `${await kidOf(raw)}:${toBase64(raw)}`;
}

export async function parseKeys(keyString) {
  const entries = String(keyString || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) throw new Error('No bundle key given');
  const keys = [];
  for (const entry of entries) {
    const [kid, encoded, extra] = entry.split(':');
    if (extra !== undefined || !KID_PATTERN.test(kid || '') || !encoded) throw new Error('A bundle key must look like <kid>:<base64 key>');
    let raw;
    try {
      raw = fromBase64(encoded);
    } catch {
      throw new Error(`Bundle key ${kid} is not valid base64`);
    }
    if (raw.length !== 32) throw new Error(`Bundle key ${kid} must be 32 bytes`);
    if ((await kidOf(raw)) !== kid) throw new Error(`Bundle key ${kid} does not match its key id`);
    keys.push({kid, key: raw});
  }
  return keys;
}

async function aesKey(material, usages) {
  if (material instanceof Uint8Array || material instanceof ArrayBuffer) {
    return subtle().importKey('raw', material, 'AES-GCM', false, usages);
  }
  return material;
}

export function isSealed(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return view.length >= 4 && MAGIC.every((value, index) => view[index] === value);
}

function validateHeader(header) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('Envelope header is not an object');
  if (header.alg !== ALGORITHM) throw new Error('Unsupported envelope algorithm');
  if (!KINDS.includes(header.kind)) throw new Error('Unknown envelope kind');
  if (typeof header.appId !== 'string' || !header.appId || header.appId.length > 128) throw new Error('Envelope header has no app id');
  if (!HASH_PATTERN.test(header.packageHash || '')) throw new Error('Envelope header has no package hash');
  if (header.kind === 'diff' && !HASH_PATTERN.test(header.baseHash || '')) throw new Error('Diff envelope has no base hash');
  if (fromBase64(header.nonce || '').length !== 7) throw new Error('Envelope nonce must be 7 bytes');
  if (!Array.isArray(header.keys) || !header.keys.length || header.keys.length > 16) throw new Error('Envelope must wrap 1 to 16 keys');
  for (const entry of header.keys) {
    if (!KID_PATTERN.test(entry?.kid || '')) throw new Error('Envelope key id is malformed');
    if (fromBase64(entry.iv || '').length !== 12 || fromBase64(entry.wrapped || '').length !== 48) throw new Error('Envelope key entry is malformed');
  }
}

export function parseEnvelope(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (!isSealed(view)) throw new Error('Not a sealed Pulsar file');
  if (view.length < PREFIX_LENGTH || view[4] !== VERSION) throw new Error('Unsupported envelope version');
  const headerLength = new DataView(view.buffer, view.byteOffset, view.byteLength).getUint32(5);
  if (headerLength < 1 || headerLength > MAX_HEADER || PREFIX_LENGTH + headerLength > view.length) throw new Error('Envelope header length is out of range');
  const headerBytes = view.subarray(PREFIX_LENGTH, PREFIX_LENGTH + headerLength);
  let header;
  try {
    header = JSON.parse(decoder.decode(headerBytes));
  } catch {
    throw new Error('Envelope header is not JSON');
  }
  validateHeader(header);
  return {header, headerBytes, payloadOffset: PREFIX_LENGTH + headerLength};
}

const wrapContext = (kid, header) => encoder.encode(`pulsar-dek|v1|${kid}|${header.appId}|${header.packageHash}|${header.kind}`);

function segmentNonce(prefix, index, last) {
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(7, index);
  nonce[11] = last ? 1 : 0;
  return nonce;
}

export async function seal({plaintext, keys, appId, packageHash, kind, baseHash}, {random = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length))} = {}) {
  const body = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
  if (!keys?.length) throw new Error('No bundle key given');
  const dataKeyRaw = random(32);
  const header = {
    alg: ALGORITHM,
    nonce: toBase64(random(7)),
    appId,
    packageHash,
    kind,
    ...(kind === 'diff' ? {baseHash} : {}),
    keys: [],
  };
  for (const {kid, key} of keys) {
    const iv = random(12);
    const wrapped = await subtle().encrypt({name: 'AES-GCM', iv, additionalData: wrapContext(kid, header)}, await aesKey(key, ['encrypt']), dataKeyRaw);
    header.keys.push({kid, iv: toBase64(iv), wrapped: toBase64(new Uint8Array(wrapped))});
  }
  validateHeader(header);
  const headerBytes = encoder.encode(JSON.stringify(header));
  if (headerBytes.length > MAX_HEADER) throw new Error('Envelope header is too large');
  const aad = new Uint8Array(await subtle().digest('SHA-256', headerBytes));
  const dataKey = await subtle().importKey('raw', dataKeyRaw, 'AES-GCM', false, ['encrypt']);
  const prefix = fromBase64(header.nonce);
  const segmentCount = Math.max(1, Math.ceil(body.length / SEGMENT_SIZE));
  const parts = [];
  for (let index = 0; index < segmentCount; index++) {
    const chunk = body.subarray(index * SEGMENT_SIZE, (index + 1) * SEGMENT_SIZE);
    const iv = segmentNonce(prefix, index, index === segmentCount - 1);
    parts.push(new Uint8Array(await subtle().encrypt({name: 'AES-GCM', iv, additionalData: aad}, dataKey, chunk)));
  }
  const total = PREFIX_LENGTH + headerBytes.length + parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  output.set(MAGIC, 0);
  output[4] = VERSION;
  new DataView(output.buffer).setUint32(5, headerBytes.length);
  output.set(headerBytes, PREFIX_LENGTH);
  let offset = PREFIX_LENGTH + headerBytes.length;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export async function unwrapDataKey(header, keys) {
  for (const entry of header.keys) {
    const match = keys.find((candidate) => candidate.kid === entry.kid);
    if (!match) continue;
    try {
      const raw = await subtle().decrypt(
        {name: 'AES-GCM', iv: fromBase64(entry.iv), additionalData: wrapContext(entry.kid, header)},
        await aesKey(match.key, ['decrypt']),
        fromBase64(entry.wrapped),
      );
      return subtle().importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    } catch {
      throw new Error(`Bundle key ${entry.kid} could not unlock this file`);
    }
  }
  throw new Error(`None of your bundle keys can open this file (it needs ${header.keys.map((entry) => entry.kid).join(' or ')})`);
}

export async function open(bytes, keys, expected = {}) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const {header, headerBytes, payloadOffset} = parseEnvelope(view);
  for (const field of ['appId', 'packageHash', 'kind', 'baseHash']) {
    if (expected[field] !== undefined && header[field] !== expected[field]) throw new Error(`Envelope ${field} does not match`);
  }
  const dataKey = await unwrapDataKey(header, keys);
  const aad = new Uint8Array(await subtle().digest('SHA-256', headerBytes));
  const prefix = fromBase64(header.nonce);
  const payload = view.subarray(payloadOffset);
  const stride = SEGMENT_SIZE + TAG_LENGTH;
  const segmentCount = Math.max(1, Math.ceil(payload.length / stride));
  if (payload.length < TAG_LENGTH || (payload.length % stride !== 0 && payload.length % stride < TAG_LENGTH)) throw new Error('Envelope payload is truncated');
  const parts = [];
  for (let index = 0; index < segmentCount; index++) {
    const segment = payload.subarray(index * stride, (index + 1) * stride);
    const iv = segmentNonce(prefix, index, index === segmentCount - 1);
    try {
      parts.push(new Uint8Array(await subtle().decrypt({name: 'AES-GCM', iv, additionalData: aad}, dataKey, segment)));
    } catch {
      throw new Error('Envelope failed authentication: the file was altered, truncated or is for another release');
    }
  }
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return {header, plaintext: output};
}
