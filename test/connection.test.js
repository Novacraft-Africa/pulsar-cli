import assert from 'node:assert';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {makeTempDir} from '../temp.js';

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const SERVER = `
const http = require('node:http');
const server = http.createServer((request, response) => {
  if (request.url === '/apps/unreachable/private-bundles') return request.socket.destroy();
  if (request.url === '/apps/old/private-bundles') {
    response.writeHead(404, {'content-type': 'application/json'});
    return response.end(JSON.stringify({error: 'Not found'}));
  }
  response.writeHead(200, {'content-type': 'application/json'});
  response.end(JSON.stringify({mode: 'off', keys: []}));
});
server.keepAliveTimeout = 3000;
server.listen(0, '127.0.0.1', () => console.log(server.address().port));
`;
const server = spawn(process.execPath, ['-e', SERVER], {stdio: ['ignore', 'pipe', 'inherit']});
const port = await new Promise((resolve) => server.stdout.once('data', (chunk) => resolve(Number(String(chunk).trim()))));
const env = {
  ...process.env,
  PULSAR_API_URL: `http://127.0.0.1:${port}`,
  PULSAR_TOKEN: 'connection-test-token',
  HOME: makeTempDir('pulsar-cli-connection-home-'),
};
Object.assign(process.env, env);

try {
  const {api} = await import('../pulsar.js');
  await api('/apps/app1/private-bundles', {optional: true});
  await api('/apps/app1/private-bundles', {optional: true});
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4500);
  assert.deepStrictEqual(await api('/apps/app1/private-bundles', {optional: true}), {mode: 'off', keys: []}, 'a GET after a long build survives the server closing the idle connection');

  const runContext = (appId) => promisify(execFile)(process.execPath, [
    '--input-type=module',
    '-e',
    `const {privateContext} = await import(${JSON.stringify(here('../private.js'))}); console.log(JSON.stringify(await privateContext({id: ${JSON.stringify(appId)}, name: 'Shop'}, [], '')));`,
  ], {env}).then(({stdout}) => ({code: 0, stdout}), (err) => ({code: err.code, stdout: err.stdout, stderr: err.stderr}));

  assert.deepStrictEqual(await runContext('app1'), {code: 0, stdout: 'null\n'}, 'an app with private bundles off releases plain');
  assert.deepStrictEqual(await runContext('old'), {code: 0, stdout: 'null\n'}, 'a server without private bundles still answers, so the release goes ahead');
  const unreachable = await runContext('unreachable');
  assert.strictEqual(unreachable.code, 1, 'no answer at all stops the release');
  assert.match(unreachable.stderr, /couldn't check whether Shop uses private bundles .*Nothing was uploaded\./);
} finally {
  server.kill();
}

console.log('connection.test.js: all assertions passed');
