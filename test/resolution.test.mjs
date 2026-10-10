import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProject, resolveProvider, resolveModel, resolveOptions } from '../src/resolution.mjs';
import { buildLaunchCommand, recover, normalizeRuntimeMode } from '../src/sessions.mjs';
import { createHash } from 'node:crypto';
import { request } from '../src/http.mjs';
const provider = { instanceId: 'user-codex', driver: 'codex', enabled: true, installed: true, status: 'ready', models: [{ slug: 'model-123', name: 'Model', aliases: ['alias'], capabilities: { optionDescriptors: [{ id: 'reasoning', type: 'select', options: [{ id: 'high' }] }, { id: 'fast', type: 'boolean' }] } }] };
test('resolves live IDs/slugs and rejects duplicate project/provider/model names', () => {
  assert.equal(resolveProject([{ id: 'random-project', name: 'T3 Controller' }], 'T3 Controller').id, 'random-project');
  assert.equal(resolveProvider([provider], 'codex').instanceId, 'user-codex');
  assert.equal(resolveModel(provider, 'alias').slug, 'model-123');
  assert.throws(() => resolveProject([{ id: 'a', name: 'X' }, { id: 'b', name: 'X' }], 'X'), { code: 'RESOLUTION' });
  assert.throws(() => resolveProvider([provider, { ...provider, instanceId: 'other-codex' }], 'codex'), { code: 'RESOLUTION' });
  assert.throws(() => resolveProvider([{ ...provider, enabled: false }], 'codex'), { code: 'RESOLUTION' });
  assert.throws(() => resolveModel({ models: [{ slug: 'a', aliases: ['alias'] }, { slug: 'b', aliases: ['alias'] }] }, 'alias'), { code: 'RESOLUTION' });
});
test('model options validated against descriptors and canonical wire values', () => {
  assert.deepEqual(resolveOptions(provider.models[0], ['reasoning=high', 'fast=false']), [{ id: 'reasoning', value: 'high' }, { id: 'fast', value: false }]);
  for (const values of [['reasoning=unknown'], ['fast=no'], ['no=high'], ['reasoning=high', 'reasoning=high'], ['oops']]) assert.throws(() => resolveOptions(provider.models[0], values), { code: 'RESOLUTION' });
});
test('controller runtime policy keeps existing behavior for non-Antigravity providers', () => {
  for (const providerDriver of ['codex', 'claudeAgent', 'cursor']) {
    assert.equal(normalizeRuntimeMode({ providerDriver }), 'auto');
    assert.equal(normalizeRuntimeMode({ providerDriver, runtimeMode: 'approval-required' }), 'auto');
    assert.equal(normalizeRuntimeMode({ providerDriver, runtimeMode: 'auto-accept-edits' }), 'auto');
    assert.equal(normalizeRuntimeMode({ providerDriver, runtimeMode: 'auto' }), 'auto');
    assert.equal(normalizeRuntimeMode({ providerDriver, runtimeMode: 'full-access' }), 'full-access');
  }
});

test('Antigravity defaults to auto_edit and gates yolo to managed worktrees', () => {
  assert.equal(normalizeRuntimeMode({ providerDriver: 'antigravity' }), 'auto-accept-edits');
  assert.equal(
    normalizeRuntimeMode({ providerDriver: 'antigravity', runtimeMode: 'approval-required' }),
    'auto',
  );
  assert.equal(
    normalizeRuntimeMode({ providerDriver: 'antigravity', runtimeMode: 'auto-accept-edits' }),
    'auto-accept-edits',
  );
  assert.equal(
    normalizeRuntimeMode({ providerDriver: 'antigravity', runtimeMode: 'auto' }),
    'auto',
  );
  assert.throws(
    () => normalizeRuntimeMode({ providerDriver: 'antigravity', runtimeMode: 'full-access' }),
    { code: 'USAGE' },
  );
  assert.equal(
    normalizeRuntimeMode({
      providerDriver: 'antigravity',
      runtimeMode: 'full-access',
      workspace: 'worktree',
    }),
    'full-access',
  );
});

test('native root bootstrap binds project and canonical selection without worktree commands', () => {
  const command = buildLaunchCommand({ project: { id: 'project', workspaceRoot: '/root' }, modelSelection: { instanceId: 'custom', model: 'actual-slug' }, title: 'Review', prompt: 'Review only', runtimeMode: 'approval-required', branch: 'main', ids: { commandId: 'command', threadId: 'thread', messageId: 'message' }, createdAt: '2026-10-03T08:00:00Z' });
  assert.equal(command.type, 'thread.turn.start');
  assert.equal(command.bootstrap.createThread.projectId, 'project');
  assert.equal(command.bootstrap.createThread.worktreePath, null);
  assert.equal(command.bootstrap.prepareWorktree, undefined);
  assert.equal(command.message.text, 'Review only');
  assert.deepEqual(command.modelSelection, command.bootstrap.createThread.modelSelection);
});
test('worktree bootstrap requires T3-managed checkout before agent start', () => {
  const command = buildLaunchCommand({ project: { id: 'project', workspaceRoot: '/root' }, modelSelection: { instanceId: 'custom', model: 'actual' }, title: 'Review', prompt: 'review', runtimeMode: 'approval-required', branch: 'main', ids: { commandId: 'c', threadId: 't', messageId: 'm' }, createdAt: '2026-10-03T08:00:00Z', workspace: 'worktree', baseBranch: 'main' });
  assert.deepEqual(command.bootstrap.prepareWorktree, { projectCwd: '/root', baseBranch: 'main', branch: 't3ctl/t', requireWorktree: true });
  assert.equal(command.bootstrap.createThread.worktreePath, null);
  assert.equal(command.bootstrap.runSetupScript, undefined);
});
test('existing worktree bootstrap binds path without asking T3 to create one', () => {
  const command = buildLaunchCommand({ project: { id: 'project', workspaceRoot: '/root' }, modelSelection: { instanceId: 'custom', model: 'actual' }, title: 'Review', prompt: 'review', runtimeMode: 'auto', branch: 'feature/existing', ids: { commandId: 'c2', threadId: 't2', messageId: 'm2' }, createdAt: '2026-10-10T08:00:00Z', workspace: 'existing-worktree', worktreePath: '/repo/wt' });
  assert.equal(command.bootstrap.createThread.branch, 'feature/existing');
  assert.equal(command.bootstrap.createThread.worktreePath, '/repo/wt');
  assert.equal(command.bootstrap.prepareWorktree, undefined);
  assert.equal(command.bootstrap.runSetupScript, undefined);
});
test('recovery correlates message ID/hash, not an unrelated latest turn; never dispatches', async () => {
  const text = 'review', receipt = { version: 1, requestId: 'key', origin: 'http://localhost:1', environmentId: 'env', projectId: 'project', threadId: 'thread', messageId: 'message', promptHash: createHash('sha256').update(text).digest('hex'), createdAt: 'original' };
  const client = { origin: receipt.origin, environment: { environmentId: 'env' }, get: async () => ({ thread: { id: 'thread', projectId: 'project', messages: [{ id: 'message', role: 'user', text, turnId: null }], latestTurn: { turnId: 'unrelated', requestedAt: 'newer' } } }), rpc: () => assert.fail('Recovery must never mutate') };
  assert.equal((await recover(client, receipt)).runId, null);
  await assert.rejects(recover(client, { ...receipt, promptHash: 'wrong' }), { code: 'UNCERTAIN' });
  await assert.rejects(recover(client, { ...receipt, environmentId: 'other' }), { code: 'UNCERTAIN' });
});
test('HTTP transport refuses cross-origin path before sending bearer', async () => {
  await assert.rejects(request('http://localhost:1', '//evil.example/path', { token: 'private' }), { code: 'USAGE' });
});
