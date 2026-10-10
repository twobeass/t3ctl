import test from 'node:test';
import assert from 'node:assert/strict';
import { wait, summarizeThread, recover, stop, stopSatisfied } from '../src/sessions.mjs';
import { parse } from '../src/cli.mjs';
import { createHash } from 'node:crypto';
const t = { id: 'thread', projectId: 'project', messages: [], activities: [], session: { status: 'ready' }, latestTurn: { turnId: 'run', state: 'completed', requestedAt: '2026-10-03T08:00:00Z' } };
const client = thread => ({ get: async () => ({ thread }), rpc: () => assert.fail('Wait must not mutate') });
test('wait reads completed turn and catches provider error, approval and timeout', async () => {
  assert.equal((await wait(client(t), 'thread', { 'wait-timeout': 0.1 })).runId, 'run');
  await assert.rejects(wait(client({ ...t, session: { status: 'error' } }), 'thread', {}), { code: 'RUN' });
  const running = { ...t, latestTurn: { ...t.latestTurn, state: 'running' }, session: { status: 'running' } };
  await assert.rejects(wait(client({ ...running, activities: [{ kind: 'approval.requested', payload: { requestId: 'approval' } }] }), 'thread', {}), { code: 'ATTENTION' });
  await assert.rejects(wait(client(running), 'thread', { 'wait-timeout': 0.01, 'poll-interval': 0.001 }), { code: 'TIMEOUT' });
  await assert.rejects(wait(client(t), 'thread', { 'run-id': 'different' }), { code: 'ATTENTION' });
});
test('wait does not return stale completed turn while a newer user send is queued', async () => {
  const thread = { ...t, messages: [{ role: 'user', createdAt: '2026-10-03T08:01:00Z' }] };
  await assert.rejects(wait(client(thread), 'thread', { 'wait-timeout': 0.01, 'poll-interval': 0.001 }), { code: 'TIMEOUT' });
});
test('pending approval/input is resolved using official activity kinds', () => {
  const result = summarizeThread({ ...t, activities: [{ kind: 'approval.requested', payload: { requestId: 'a' } }, { kind: 'approval.resolved', payload: { requestId: 'a' } }, { kind: 'user-input.requested', payload: { requestId: 'b' } }, { kind: 'user-input.resolved', payload: { requestId: 'b' } }] });
  assert.deepEqual(result.pendingInput, []);
});
test('recover finds first response turn even after another user turn', async () => {
  const prompt = 'review', receipt = { version: 1, origin: 'http://localhost:1', environmentId: 'env', projectId: 'project', threadId: 'thread', messageId: 'message', promptHash: createHash('sha256').update(prompt).digest('hex'), createdAt: '2026-10-03T08:00:00Z' };
  const thread = { ...t, latestTurn: { ...t.latestTurn, turnId: 'later', requestedAt: '2026-10-03T08:05:00Z' }, messages: [{ id: 'message', role: 'user', text: prompt }, { role: 'assistant', turnId: 'original' }, { role: 'user', text: 'later' }, { role: 'assistant', turnId: 'later' }] };
  assert.equal((await recover({ ...client(thread), origin: receipt.origin, environment: { environmentId: 'env' } }, receipt)).runId, 'original');
});
test('CLI requires thread IDs and bounded wait options', () => {
  assert.equal(parse(['wait', 'thread', '--wait-timeout', '1']).id, 'thread');
  for (const args of [['wait'], ['send'], ['stop', 'thread', '--recover'], ['wait', 'thread', '--poll-interval', '0']]) assert.throws(() => parse(args), { code: 'USAGE' });
});
test('interrupt during startup with no turn ID is not falsely confirmed or dispatched', async () => {
  const starting = { ...t, session: { status: 'starting', activeTurnId: null } };
  await assert.rejects(stop(client(starting), 'thread', { interrupt: true }), { code: 'ATTENTION' });
  assert.equal(stopSatisfied(starting, true), false);
  assert.equal(stopSatisfied({ ...t, session: { status: 'idle' } }), true);
  assert.equal(stopSatisfied({ ...t, session: { status: 'ready' } }), false);
});
test('pending requests ignore refresh, empty inputs and stale failed replies; closed stays closed', () => {
  const activities = [
    { kind: 'approval.requested', payload: { requestId: 'refresh', requestType: 'auth_tokens_refresh' } },
    { kind: 'user-input.requested', payload: { requestId: 'empty', questions: [] } },
    { kind: 'approval.resolved', payload: { requestId: 'closed' } },
    { kind: 'approval.requested', payload: { requestId: 'closed' } },
    { kind: 'approval.requested', payload: { requestId: 'stale' } },
    { kind: 'provider.approval.respond.failed', payload: { requestId: 'stale', detail: 'unknown pending codex approval request' } },
  ];
  assert.deepEqual(summarizeThread({ ...t, activities }).pendingInput, []);
});
test('wait with malformed timestamps fails closed rather than returning previous completion', async () => {
  await assert.rejects(wait(client({ ...t, messages: [{ role: 'user' }] }), 'thread', { 'wait-timeout': 0.01, 'poll-interval': 0.001 }), { code: 'TIMEOUT' });
});
