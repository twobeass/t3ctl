import test from 'node:test';
import assert from 'node:assert/strict';
import { guardVersion, validateUrl, discover } from '../src/discovery.mjs';
import { parse } from '../src/cli.mjs';
import { redact } from '../src/errors.mjs';
import { decodeFrames, RpcClient } from '../src/rpc.mjs';
import { projects } from '../src/client.mjs';

test('strict version and protocol guard', () => {
  guardVersion({ serverVersion: '0.0.45' });
  guardVersion({ serverVersion: '0.0.46-nightly.20261010.2908', orchestrationProtocolVersion: 2 });
  for (const environment of [
    { serverVersion: '0.0.46-preview.20261010.2909', orchestrationProtocolVersion: 2 },
    { serverVersion: '0.0.46', orchestrationProtocolVersion: 2 },
    { serverVersion: '0.0.46', orchestrationProtocolVersion: 1 },
    { serverVersion: '0.0.45-preview', orchestrationProtocolVersion: 1 },
    { serverVersion: '0.0.45', orchestrationProtocolVersion: 2 },
    { serverVersion: '0.0.47', orchestrationProtocolVersion: 2 },
    {},
  ]) assert.throws(() => guardVersion(environment), { code: 'VERSION' });
});
test('origin parsing excludes credential/query/path injection', () => {
  assert.equal(validateUrl('http://localhost:3773'), 'http://localhost:3773');
  for (const url of ['file:///tmp', 'http://user:secret@localhost', 'http://localhost?token=secret', 'http://localhost/foo', 'not a url']) assert.throws(() => validateUrl(url), { code: 'USAGE' });
});
test('remote URL never receives implicit local credentials', async () => {
  const result = await discover({ url: 'https://other.example', 'base-dir': '/does-not-exist' }, {});
  assert.equal(result.autoAuth, false);
});
test('CLI rejects unknown commands, options and invalid timeouts', () => {
  assert.equal(parse(['models', '--json']).command, 'models');
  for (const args of [[], ['models', '--token', 'secret'], ['delete'], ['status', 'extra'], ['status', '--timeout', 'NaN'], ['status', '--timeout', '0']]) assert.throws(() => parse(args), { code: 'USAGE' });
});
test('CLI accepts existing worktrees and rejects ambiguous workspace flags', () => {
  const base = ['launch', '--project', 'Project', '--provider', 'codex', '--model', 'model', '--title', 'Task', '--prompt', 'Do it'];
  assert.equal(parse([...base, '--existing-worktree', '/repo/wt']).options['existing-worktree'], '/repo/wt');
  for (const extra of [
    ['--existing-worktree', '/repo/wt', '--workspace', 'worktree'],
    ['--existing-worktree', '/repo/wt', '--base-branch', 'main'],
    ['--existing-worktree', '/repo/wt', '--run-setup-script'],
    ['--existing-worktree', ''],
    ['--existing-worktree', 'relative/path'],
  ]) assert.throws(() => parse([...base, ...extra]), { code: 'USAGE' });
});
test('project names use native title and deleted projects are excluded', async () => {
  const result = await projects({ get: async () => ({ projects: [{ id: 'p', title: 'T3 Controller', workspaceRoot: '/repo' }, { id: 'gone', title: 'Gone', deletedAt: 'date' }] }) });
  assert.deepEqual(result, [{ id: 'p', name: 'T3 Controller', workspaceRoot: '/repo', defaultThreadEnvMode: undefined }]);
});
test('redaction masks credential fields and bearer/ticket strings', () => {
  const safe = redact({ token: 'secret-one', auth: { access_token: 'secret-two' }, message: 'Bearer secret-three', url: 'ws://host/ws?wsTicket=secret-four&orchestrationProtocol=1' });
  for (const secret of ['secret-one', 'secret-two', 'secret-three', 'secret-four']) assert.ok(!safe.includes(secret));
});

class Socket extends EventTarget {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  receive(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}
test('Effect RPC correlates out-of-order batched Exit frames', async () => {
  const socket = new Socket(), rpc = new RpcClient(socket);
  const first = rpc.call('server.getConfig'), second = rpc.call('vcs.refreshStatus', { cwd: '/repo' });
  assert.deepEqual(socket.sent[0], { _tag: 'Request', id: '1', tag: 'server.getConfig', payload: {}, headers: [] });
  socket.receive([{ _tag: 'Exit', requestId: '2', exit: { _tag: 'Success', value: 'second' } }, { _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: 'first' } }]);
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  rpc.close();
});
test('RPC failure suppresses arbitrary provider/error payload and rejects', async () => {
  const socket = new Socket(), rpc = new RpcClient(socket);
  const promise = rpc.call('server.getConfig');
  socket.receive({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'EnvironmentAuthorizationError', message: 'secret' } }] } });
  await assert.rejects(promise, error => error.code === 'PROTOCOL' && !JSON.stringify(error).includes('secret'));
  rpc.close();
});
test('disconnect and timeout fail once without replay', async () => {
  const socket = new Socket(), rpc = new RpcClient(socket, 10);
  await assert.rejects(rpc.call('server.getConfig'), { code: 'NETWORK' });
  assert.equal(socket.sent.length, 1);
  const pending = rpc.call('server.getConfig');
  socket.close();
  await assert.rejects(pending, { code: 'NETWORK' });
  rpc.close();
});
test('frame decoder and RPC allowlist', () => {
  assert.deepEqual(decodeFrames('{"_tag":"Pong"}'), [{ _tag: 'Pong' }]);
  const v1 = new RpcClient(new Socket(), 15000, true, 1);
  assert.throws(() => v1.call('orchestration.launchThread', {}), { code: 'USAGE' });
  v1.close();
  const v2 = new RpcClient(new Socket(), 15000, true, 2);
  const launch = v2.call('orchestration.launchThread', { projectId: 'p' });
  assert.equal(v2.socket.sent[0].tag, 'orchestration.launchThread');
  v2.socket.receive({ _tag: 'Exit', requestId: '1', exit: { _tag: 'Success', value: { threadId: 't' } } });
  return launch.finally(() => v2.close());
});

test('CLI exposes watch and launch/send watch convenience with bounded monitoring options', () => {
  assert.equal(parse(['watch', 'thread', '--run-id', 'run', '--watch-timeout', '3600']).command, 'watch');
  const launch = ['launch', '--project', 'Project', '--provider', 'codex', '--model', 'model', '--title', 'Task', '--prompt', 'Do it'];
  assert.equal(parse([...launch, '--watch', '--watch-timeout', '7200', '--poll-interval', '2']).options.watch, true);
  assert.equal(parse(['send', 'thread', '--prompt', 'continue', '--watch']).options.watch, true);
  for (const args of [
    ['watch'],
    ['watch', 'thread', '--watch-timeout', '86401'],
    [...launch, '--watch-timeout', '10'],
    ['send', 'thread', '--prompt', 'continue', '--poll-interval', '2'],
  ]) assert.throws(() => parse(args), { code: 'USAGE' });
});
