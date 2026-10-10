import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { launch } from '../src/sessions.mjs';
import { JOURNAL_DIR, readReceipt } from '../src/journal.mjs';
import { ControllerError } from '../src/errors.mjs';

test('lost launch response is recovered; same request never starts a second native thread', async () => {
  const requestId = `unit-recovery-${randomUUID()}`;
  let thread, dispatches = 0;
  const options = { project: 'Project', provider: 'driver', model: 'model', title: 'Review', prompt: 'Fixture review', 'request-id': requestId };
  const environment = { serverVersion: '0.0.45', environmentId: 'env' };
  const client = { origin: 'http://localhost:1', environment,
    get: async path => path.endsWith('/shell') ? { projects: [{ id: 'live-project', title: 'Project', workspaceRoot: '/fixture' }] } : { thread },
    rpc: async (method, payload) => {
      if (method === 'server.getConfig') return { environment, providers: [{ instanceId: 'actual-instance', driver: 'driver', enabled: true, installed: true, status: 'ready', models: [{ slug: 'model' }] }] };
      if (method === 'vcs.refreshStatus') return { isRepo: true, refName: 'main' };
      assert.equal(method, 'orchestration.dispatchCommand');
      dispatches++;
      const receipt = await readReceipt(requestId);
      assert.equal(receipt.threadId, payload.threadId); // persisted before mutation
      thread = { id: payload.threadId, projectId: 'live-project', modelSelection: payload.modelSelection, messages: [{ id: payload.message.messageId, role: 'user', text: payload.message.text, turnId: null }], latestTurn: { turnId: 'native-run', requestedAt: payload.createdAt, state: 'running' }, session: { status: 'running' } };
      throw new ControllerError('NETWORK', 'Simulated lost response');
    },
  };
  try {
    const first = await launch(client, options);
    assert.equal(first.runId, 'native-run');
    assert.equal(first.dispatchConfirmed, false);
    const second = await launch(client, options);
    assert.equal(second.threadId, first.threadId);
    assert.equal(dispatches, 1);
    await assert.rejects(launch(client, { ...options, prompt: 'different' }), { code: 'UNCERTAIN' });
    assert.equal(dispatches, 1);
  } finally { await unlink(`${JOURNAL_DIR}/${requestId}.json`); }
});

test('V2 lost launch response recovers the native launch without replay', async () => {
  const requestId = `unit-v2-recovery-${randomUUID()}`;
  let snapshot, dispatches = 0;
  const options = { project: 'Project', provider: 'driver', model: 'model', title: 'V2', prompt: 'Fixture V2', 'request-id': requestId };
  const environment = { serverVersion: '0.0.46-nightly.20261010.2908', orchestrationProtocolVersion: 2, environmentId: 'env-v2' };
  const client = {
    protocol: 2, origin: 'http://localhost:2', environment,
    get: async path => path.endsWith('/shell')
      ? { projects: [{ id: 'project-v2', title: 'Project', workspaceRoot: '/fixture' }], threads: [] }
      : snapshot,
    rpc: async (method, payload) => {
      if (method === 'server.getConfig') return { environment, providers: [{ instanceId: 'actual-instance', driver: 'driver', enabled: true, installed: true, status: 'ready', models: [{ slug: 'model' }] }] };
      if (method === 'vcs.refreshStatus') return { isRepo: true, refName: 'main' };
      assert.equal(method, 'orchestration.launchThread');
      dispatches++;
      const receipt = await readReceipt(requestId);
      assert.equal(receipt.threadId, payload.threadId);
      snapshot = { projection: {
        thread: { id: payload.threadId, projectId: 'project-v2', title: 'V2', modelSelection: payload.modelSelection, runtimeMode: payload.runtimeMode, interactionMode: 'default', branch: 'main', worktreePath: null },
        runs: [{ id: 'run-v2', threadId: payload.threadId, status: 'running', requestedAt: '2026-10-10T08:00:00Z', startedAt: '2026-10-10T08:00:01Z', completedAt: null, userMessageId: payload.initialMessage.messageId }],
        messages: [{ id: payload.initialMessage.messageId, threadId: payload.threadId, runId: 'run-v2', role: 'user', text: payload.initialMessage.text, attachments: [], streaming: false, createdAt: '2026-10-10T08:00:00Z', updatedAt: '2026-10-10T08:00:00Z' }],
        runtimeRequests: [], providerSessions: [], attempts: [], nodes: [], subagents: [], providerThreads: [], providerTurns: [], plans: [], turnItems: [], checkpointScopes: [], checkpoints: [], contextHandoffs: [], contextTransfers: [], visibleTurnItems: [], updatedAt: '2026-10-10T08:00:01Z',
      }};
      throw new ControllerError('NETWORK', 'Simulated lost V2 response');
    },
  };
  try {
    const first = await launch(client, options);
    assert.equal(first.runId, 'run-v2');
    assert.equal(first.dispatchConfirmed, false);
    const second = await launch(client, options);
    assert.equal(second.threadId, first.threadId);
    assert.equal(dispatches, 1);
  } finally {
    await unlink(`${JOURNAL_DIR}/${requestId}.json`);
  }
});

test('remote V2 existing-worktree launch fails closed before dispatch', async () => {
  const environment = { serverVersion: '0.0.46-nightly.20261010.2908', orchestrationProtocolVersion: 2, environmentId: 'env-v2' };
  let mutations = 0;
  const client = {
    protocol: 2, autoAuth: false, origin: 'https://remote.example', environment,
    get: async path => path.endsWith('/shell')
      ? { projects: [{ id: 'project-v2', title: 'Project', workspaceRoot: '/repo' }], threads: [] }
      : assert.fail('thread read not expected'),
    rpc: async method => {
      if (method === 'server.getConfig') return { environment, providers: [{ instanceId: 'actual-instance', driver: 'driver', enabled: true, installed: true, status: 'ready', models: [{ slug: 'model' }] }] };
      mutations++;
      assert.fail('mutation/status RPC not expected');
    },
  };
  await assert.rejects(
    launch(client, { project: 'Project', provider: 'driver', model: 'model', title: 'Remote WT', prompt: 'No dispatch', 'existing-worktree': '/repo/wt' }),
    { code: 'USAGE' },
  );
  assert.equal(mutations, 0);
});
