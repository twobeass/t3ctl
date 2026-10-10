import test from 'node:test';
import assert from 'node:assert/strict';
import {
  activeV2Run,
  buildV2LaunchPayload,
  buildV2SendCommand,
  buildV2StopCommand,
  normalizeV2Snapshot,
  v2WorkspaceStrategy,
} from '../src/v2.mjs';

const ids = { commandId: 'cmd', threadId: 'thread', messageId: 'message' };
const project = { id: 'project', workspaceRoot: '/repo' };
const modelSelection = { instanceId: 'codex', model: 'gpt-6.1-sol' };

function projection(status = 'completed') {
  const run = {
    id: 'run-1', threadId: 'thread', ordinal: 1, providerInstanceId: 'codex',
    modelSelection, userMessageId: 'message', status,
    requestedAt: '2026-10-10T08:00:00Z',
    startedAt: '2026-10-10T08:00:01Z',
    completedAt: status === 'completed' ? '2026-10-10T08:01:00Z' : null,
  };
  return {
    thread: {
      id: 'thread', projectId: 'project', title: 'Task', modelSelection,
      runtimeMode: 'auto', interactionMode: 'default', branch: 'main',
      worktreePath: null,
    },
    runs: [run],
    messages: [
      {
        id: 'message', threadId: 'thread', runId: 'run-1', role: 'user',
        text: 'Do it', attachments: [], streaming: false,
        createdAt: '2026-10-10T08:00:00Z', updatedAt: '2026-10-10T08:00:00Z',
      },
    ],
    runtimeRequests: [],
    providerSessions: [],
    attempts: [], nodes: [], subagents: [], providerThreads: [], providerTurns: [],
    plans: [], turnItems: [], checkpointScopes: [], checkpoints: [],
    contextHandoffs: [], contextTransfers: [], visibleTurnItems: [],
    updatedAt: '2026-10-10T08:01:00Z',
  };
}

test('V2 snapshot normalization preserves thread identity and run correlation', () => {
  const normalized = normalizeV2Snapshot({ projection: projection() });
  assert.equal(normalized.id, 'thread');
  assert.equal(normalized.latestTurn.turnId, 'run-1');
  assert.equal(normalized.latestTurn.state, 'completed');
  assert.equal(normalized.messages[0].turnId, 'run-1');
  assert.equal(normalized.session.status, 'ready');
});
test('V2 snapshot exposes active work and pending runtime attention', () => {
  const p = projection('waiting');
  p.runtimeRequests = [{
    id: 'approval-1', nodeId: 'node', providerTurnId: null, nativeRequestRef: null,
    kind: 'command', status: 'pending',
    responseCapability: { type: 'message' },
    createdAt: '2026-10-10T08:00:10Z', resolvedAt: null,
  }];
  const normalized = normalizeV2Snapshot({ projection: p });
  assert.equal(activeV2Run(p).id, 'run-1');
  assert.equal(normalized.session.status, 'running');
  assert.equal(normalized.session.activeTurnId, 'run-1');
  assert.equal(normalized.activities[0].payload.requestId, 'approval-1');
});

test('V2 launch payload uses native workspace strategies', () => {
  const root = buildV2LaunchPayload({
    project, modelSelection, title: 'Task', prompt: 'Do it', runtimeMode: 'auto',
    branch: 'main', ids, workspace: 'root',
  });
  assert.deepEqual(root.workspaceStrategy, { type: 'root', branch: 'main' });
  assert.equal(root.initialMessage.messageId, 'message');

  const wt = buildV2LaunchPayload({
    project, modelSelection, title: 'Task', prompt: 'Do it', runtimeMode: 'auto',
    branch: 'main', ids, workspace: 'worktree', baseBranch: 'feature/base',
  });
  assert.deepEqual(wt.workspaceStrategy, {
    type: 'worktree', baseRef: 'feature/base', branch: 't3ctl/thread', startFromOrigin: false,
  });
  const existing = v2WorkspaceStrategy({
    workspace: 'existing-worktree',
    existingWorktree: { path: '/repo/wt', branch: 'feature/existing' },
  });
  assert.deepEqual(existing, {
    type: 'existing_worktree', worktreePath: '/repo/wt', branch: 'feature/existing',
  });
});

test('V2 external follow-up and stop use native commands', () => {
  assert.deepEqual(
    buildV2SendCommand({ commandId: 'send', threadId: 'thread', messageId: 'm2', text: 'Continue' }),
    {
      type: 'message.dispatch', commandId: 'send', createdBy: 'user',
      creationSource: 'web', threadId: 'thread', messageId: 'm2',
      text: 'Continue', attachments: [], dispatchMode: { type: 'start_immediately' },
    },
  );
  const normalized = normalizeV2Snapshot({ projection: projection('running') });
  assert.deepEqual(buildV2StopCommand(normalized, 'stop'), {
    type: 'run.interrupt', commandId: 'stop', threadId: 'thread',
    runId: 'run-1', holdQueue: true,
  });
  const idle = normalizeV2Snapshot({ projection: projection('completed') });
  assert.equal(buildV2StopCommand(idle, 'stop'), null);
});
