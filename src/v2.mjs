import { ControllerError } from './errors.mjs';

const ACTIVE = new Set(['preparing', 'queued', 'starting', 'running', 'waiting']);

export function activeV2Run(projection) {
  return [...(projection?.runs ?? [])].reverse().find(run => ACTIVE.has(run.status)) ?? null;
}

function sessionStatus(run) {
  if (!run) return 'ready';
  if (['preparing', 'queued', 'starting'].includes(run.status)) return 'starting';
  if (['running', 'waiting'].includes(run.status)) return 'running';
  if (run.status === 'failed') return 'error';
  if (run.status === 'interrupted') return 'interrupted';
  if (run.status === 'cancelled') return 'stopped';
  return 'ready';
}

function turnState(run) {
  if (!run) return null;
  if (run.status === 'failed') return 'error';
  if (['interrupted', 'cancelled'].includes(run.status)) return 'interrupted';
  if (['completed', 'rolled_back'].includes(run.status)) return 'completed';
  return run.status === 'preparing' || run.status === 'queued' || run.status === 'starting'
    ? 'starting'
    : 'running';
}
export function normalizeV2Snapshot(snapshot) {
  const projection = snapshot?.projection;
  const thread = projection?.thread;
  if (!thread?.id || !Array.isArray(projection?.runs) || !Array.isArray(projection?.messages)) {
    throw new ControllerError('PROTOCOL', 'Ungültiger T3-V2-Thread-Snapshot.');
  }
  const latestRun = projection.runs.at(-1) ?? null;
  const activeRun = activeV2Run(projection);
  const lastError =
    [...(projection.providerSessions ?? [])].reverse().find(session => session.lastError)?.lastError ?? null;
  const pendingRequests = (projection.runtimeRequests ?? []).filter(request => request.status === 'pending');
  const activities = pendingRequests
    .filter(request => request.kind !== 'auth_refresh')
    .map(request => ({
      kind: 'approval.requested',
      payload: { requestId: request.id, requestType: request.kind, requestKind: request.kind },
    }));
  return {
    ...thread,
    session: {
      status: sessionStatus(activeRun ?? latestRun),
      activeTurnId: activeRun?.id ?? null,
      lastError,
    },
    latestTurn: latestRun
      ? {
          turnId: latestRun.id,
          state: turnState(latestRun),
          requestedAt: latestRun.requestedAt,
          startedAt: latestRun.startedAt,
          completedAt: latestRun.completedAt,
        }
      : null,
    messages: projection.messages.map(message => ({ ...message, turnId: message.runId })),
    activities,
    _v2: projection,
  };
}
export function v2WorkspaceStrategy({ workspace, existingWorktree, branch, baseBranch, threadId }) {
  if (workspace === 'worktree') {
    if (!baseBranch) throw new ControllerError('RESOLUTION', 'V2-Worktree braucht eine Basis-Branch.');
    return {
      type: 'worktree',
      baseRef: baseBranch,
      branch: `t3ctl/${threadId}`,
      startFromOrigin: false,
    };
  }
  if (workspace === 'existing-worktree') {
    if (!existingWorktree?.path) throw new ControllerError('RESOLUTION', 'Existing Worktree fehlt.');
    return {
      type: 'existing_worktree',
      worktreePath: existingWorktree.path,
      ...(existingWorktree.branch ? { branch: existingWorktree.branch } : {}),
    };
  }
  return { type: 'root', ...(branch ? { branch } : {}) };
}

export function buildV2LaunchPayload(input) {
  return {
    commandId: input.ids.commandId,
    threadId: input.ids.threadId,
    projectId: input.project.id,
    title: input.title,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimeMode,
    interactionMode: 'default',
    workspaceStrategy: v2WorkspaceStrategy({ ...input, threadId: input.ids.threadId }),
    initialMessage: {
      messageId: input.ids.messageId,
      text: input.prompt,
      attachments: [],
    },
  };
}
export function buildV2SendCommand({ commandId, threadId, messageId, text }) {
  return {
    type: 'message.dispatch',
    commandId,
    createdBy: 'user',
    creationSource: 'web',
    threadId,
    messageId,
    text,
    attachments: [],
    dispatchMode: { type: 'start_immediately' },
  };
}

export function buildV2StopCommand(thread, commandId) {
  const run = activeV2Run(thread?._v2);
  if (!run) return null;
  return {
    type: 'run.interrupt',
    commandId,
    threadId: thread.id,
    runId: run.id,
    holdQueue: true,
  };
}
