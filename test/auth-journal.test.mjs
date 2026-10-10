import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile, symlink, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { authenticate } from '../src/auth.mjs';
import { claimReceipt, readReceipt, requestKey } from '../src/journal.mjs';

async function temporary(run) {
  await mkdir('.t3ctl', { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(resolve('.t3ctl/unit-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true }); }
}
test('local auto-auth is ephemeral and only its own session is revoked once', async () => {
  const calls = [];
  const fakeCli = async (binary, args) => {
    calls.push(args);
    if (args[0] === '--version') return 't3 v0.0.45\n';
    if (args[2] === 'issue') return JSON.stringify({ token: 'fixture-bearer', sessionId: 'own-session' });
    return 'Revoked';
  };
  const auth = await authenticate({ autoAuth: true, baseDir: '/fixture' }, {}, {}, fakeCli);
  assert.equal(auth.source, 'local-cli-ephemeral');
  assert.ok(calls[1].includes('10m'));
  await auth.cleanup(); await auth.cleanup();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2], ['auth', 'session', 'revoke', 'own-session', '--base-dir', '/fixture']);
});
test('local auto-auth uses the exact installed runtime binary for V2', async () => temporary(async directory => {
  const version = '0.0.46-nightly.20261010.2908';
  const binary = `${directory}/runtime/versions/${version}/t3`;
  await mkdir(`${directory}/runtime/versions/${version}`, { recursive: true });
  await writeFile(binary, '#!/bin/sh\n', { mode: 0o700 });
  await chmod(binary, 0o700);
  const binaries = [];
  const fakeCli = async (calledBinary, args) => {
    binaries.push(calledBinary);
    if (args[0] === '--version') return `t3 v${version}\n`;
    if (args[2] === 'issue') return JSON.stringify({ token: 'fixture-v2', sessionId: 'v2-session' });
    return 'Revoked';
  };
  const auth = await authenticate({ autoAuth: true, baseDir: directory, serverVersion: version }, {}, {}, fakeCli);
  await auth.cleanup();
  assert.deepEqual([...new Set(binaries)], [binary]);
}));
test('explicit bearer avoids CLI; remote auto-auth and malformed bearers rejected', async () => {
  const noCli = () => assert.fail('No CLI auth expected');
  const auth = await authenticate({ autoAuth: false }, {}, { T3CTL_TOKEN: 'fixture' }, noCli);
  await auth.cleanup();
  await assert.rejects(authenticate({ autoAuth: false }, {}, {}, noCli), { code: 'AUTH' });
  await assert.rejects(authenticate({}, {}, { T3CTL_TOKEN: 'contains whitespace' }, noCli), { code: 'AUTH' });
});
test('auth requires private regular token file and refuses symlinks/conflicting sources', async () => temporary(async directory => {
  const path = `${directory}/token`;
  await writeFile(path, 'fixture-token\n', { mode: 0o600 });
  assert.equal((await authenticate({}, { 'token-file': path }, {})).token, 'fixture-token');
  await symlink(path, `${directory}/link`);
  await assert.rejects(authenticate({}, { 'token-file': `${directory}/link` }, {}), { code: 'AUTH' });
  await writeFile(`${directory}/public`, 'fixture', { mode: 0o644 });
  await chmod(`${directory}/public`, 0o644);
  await assert.rejects(authenticate({}, { 'token-file': `${directory}/public` }, {}), { code: 'AUTH' });
  await assert.rejects(authenticate({}, { 'token-file': path }, { T3CTL_TOKEN: 'fixture' }), { code: 'USAGE' });
}));
test('journal concurrent claims have one owner; immutable 0600 receipt survives', async () => temporary(async directory => {
  const receipt = { requestId: 'same-request', threadId: 'thread' };
  const results = await Promise.all([claimReceipt(receipt, directory), claimReceipt(receipt, directory)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(await readReceipt('same-request', directory), receipt);
  assert.equal((await stat(`${directory}/same-request.json`)).mode & 0o777, 0o600);
  assert.equal(await claimReceipt({ ...receipt, threadId: 'different' }, directory), false);
  assert.deepEqual(await readReceipt('same-request', directory), receipt);
  for (const key of ['../escape', 'a/b', '', 'a'.repeat(101)]) assert.throws(() => requestKey(key), { code: 'USAGE' });
}));
