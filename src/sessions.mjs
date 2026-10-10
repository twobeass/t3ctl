import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { projects, providers } from './client.mjs';
import { resolveProject, resolveProvider, resolveModel, resolveOptions } from './resolution.mjs';
import { requestKey, readReceipt, claimReceipt } from './journal.mjs';
import { ControllerError } from './errors.mjs';
import { validateExistingWorktree } from './worktree.mjs';
import { buildV2LaunchPayload, buildV2SendCommand, buildV2StopCommand, normalizeV2Snapshot } from './v2.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const MINIMUM_RUNTIME_MODE = 'auto';
const BELOW_MINIMUM_RUNTIME_MODES = new Set(['approval-required', 'auto-accept-edits']);
const protocolOf = client => client.protocol ?? 1;
export function normalizeRuntimeMode({ providerDriver, runtimeMode, workspace = 'root' }) {
  if (providerDriver === 'antigravity' && runtimeMode === undefined) return 'auto-accept-edits';
  const mode = runtimeMode ?? MINIMUM_RUNTIME_MODE;
  if (providerDriver === 'antigravity') {
    if (mode === 'approval-required') return MINIMUM_RUNTIME_MODE;
    if (mode === 'auto-accept-edits') return mode;
    if (mode === 'full-access' && workspace !== 'worktree') {
      throw new ControllerError(
        'USAGE',
        'Antigravity full-access (native: yolo) ist nur in einem T3-gemanagten Worktree zulässig.',
      );
    }
    return mode;
  }
  return BELOW_MINIMUM_RUNTIME_MODES.has(mode) ? MINIMUM_RUNTIME_MODE : mode;
}
export function threadId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\s/\\?#\x00-\x1f]/.test(value)) throw new ControllerError('USAGE', 'Ungültige Thread-ID.');
  return value;
}
export async function readThread(client, id) {
  const snapshot = await client.get(`/api/orchestration/threads/${encodeURIComponent(threadId(id))}`);
  if (protocolOf(client) === 2) return normalizeV2Snapshot(snapshot);
  if (snapshot.thread?.id !== id || !Array.isArray(snapshot.thread?.messages)) throw new ControllerError('PROTOCOL', 'Ungültiger T3-Thread-Snapshot.');
  return snapshot.thread;
}
export async function promptFrom(options) {
  if (Boolean(options['prompt-file']) === Boolean(options.prompt)) throw new ControllerError('USAGE', 'Genau --prompt-file FILE oder --prompt TEXT angeben.');
  let prompt;
  try { prompt = options['prompt-file'] ? await readFile(options['prompt-file'], 'utf8') : options.prompt; }
  catch { throw new ControllerError('USAGE', 'Prompt-Datei nicht lesbar.'); }
  if (!prompt.trim() || Buffer.byteLength(prompt) > 1024 * 1024) throw new ControllerError('USAGE', 'Prompt muss 1–1048576 Bytes enthalten.');
  return prompt;
}
export function buildLaunchCommand({ project, modelSelection, title, prompt, runtimeMode, branch, ids, createdAt, workspace = 'root', baseBranch, worktreePath = null }) {
  const command = {
    type: 'thread.turn.start', commandId: ids.commandId, threadId: ids.threadId,
    message: { messageId: ids.messageId, role: 'user', text: prompt, attachments: [] },
    modelSelection, runtimeMode, interactionMode: 'default', createdAt,
    bootstrap: { createThread: { projectId: project.id, title, modelSelection, runtimeMode, interactionMode: 'default', branch, worktreePath, createdAt } },
  };
  if (workspace === 'worktree') command.bootstrap.prepareWorktree = { projectCwd: project.workspaceRoot, baseBranch, branch: `t3ctl/${ids.threadId}`, requireWorktree: true };
  return command;
}
function assertReceipt(client, receipt) {
  if (receipt.version !== 1 || receipt.origin !== client.origin || receipt.environmentId !== client.environment.environmentId || (receipt.protocol !== undefined && receipt.protocol !== protocolOf(client))) {
    throw new ControllerError('UNCERTAIN', 'Request-Beleg gehört nicht zu dieser T3-Instanz oder Protokollgeneration.', { requestId: receipt.requestId });
  }
}
export async function recover(client, receipt) {
  assertReceipt(client, receipt);
  let thread;
  try { thread = await readThread(client, receipt.threadId); }
  catch (error) {
    if (error.code !== 'RESOLUTION') throw new ControllerError(error.code ?? 'NETWORK', 'Thread-Recovery konnte T3 nicht lesen.', { requestId: receipt.requestId, threadId: receipt.threadId, commandId: receipt.commandId, runId: null });
    throw new ControllerError('UNCERTAIN', 'Thread noch nicht auffindbar; Beleg behalten, Bootstrap nicht wiederholen.', { requestId: receipt.requestId, threadId: receipt.threadId, commandId: receipt.commandId, runId: null, recoveryState: 'not-found' });
  }
  const message = thread.messages.find(m => m.id === receipt.messageId && m.role === 'user');
  if (!message || hash(message.text) !== receipt.promptHash || thread.projectId !== receipt.projectId) {
    throw new ControllerError('UNCERTAIN', 'Thread vorhanden, Request noch nicht eindeutig zugeordnet; nicht erneut senden.', { requestId: receipt.requestId, threadId: receipt.threadId, recoveryState: !message ? 'message-pending' : 'message-mismatch' });
  }
  // v0.0.45 leaves user message turnId null and stamps requestedAt from the
  // provider session update, not the client command timestamp. Correlate the
  // response segment between this message and the next user message instead.
  const index = thread.messages.indexOf(message);
  const following = thread.messages.slice(index + 1);
  const nextUser = following.findIndex(m => m.role === 'user');
  const segment = nextUser < 0 ? following : following.slice(0, nextUser);
  const responseTurn = segment.find(m => m.role === 'assistant' && m.turnId)?.turnId;
  const latest = thread.latestTurn;
  const latestMatches = nextUser < 0 && latest?.turnId !== receipt.priorTurnId && Date.parse(latest?.requestedAt) >= Date.parse(receipt.createdAt);
  const runId = message.turnId ?? responseTurn ?? (latestMatches ? latest.turnId : null);
  return { requestId: receipt.requestId, threadId: thread.id, commandId: receipt.commandId, messageId: receipt.messageId, runId, turnId: runId, projectId: thread.projectId, modelSelection: thread.modelSelection, workspace: { branch: thread.branch, worktreePath: thread.worktreePath }, status: thread.session?.status ?? 'pending', turnState: thread.latestTurn?.turnId === runId ? thread.latestTurn.state : null, recovered: true };
}
export async function launch(client, options) {
  const requestId = requestKey(options['request-id'] ?? randomUUID());
  const existing = await readReceipt(requestId);
  if (options.recover) {
    if (!existing || existing.kind !== 'launch') throw new ControllerError('RESOLUTION', 'Kein Launch-Beleg gefunden.', { requestId });
    return recover(client, existing);
  }
  const prompt = await promptFrom(options);
  const project = resolveProject(await projects(client), options.project);
  const provider = resolveProvider(await providers(client), options.provider);
  let existingWorktree = null;
  if (options['existing-worktree']) {
    if (protocolOf(client) === 2 && !client.autoAuth) {
      throw new ControllerError('USAGE', 'Remote V2 --existing-worktree wird ohne serverseitige Worktree-Listenprüfung nicht angeboten.');
    }
    existingWorktree = await validateExistingWorktree(client, project, options['existing-worktree']);
  }
  const workspace = existingWorktree ? 'existing-worktree' : (options.workspace ?? 'root');
  if (protocolOf(client) === 2 && options['run-setup-script']) {
    throw new ControllerError('USAGE', '--run-setup-script ist in T3 V2 nicht steuerbar; V2 verwendet den nativen Setup-Flow.');
  }
  const runtimeMode = normalizeRuntimeMode({
    providerDriver: provider.driver,
    runtimeMode: options['runtime-mode'],
    workspace,
  });
  const fingerprint = hash(JSON.stringify({ protocol: protocolOf(client), promptHash: hash(prompt), project: options.project, provider: options.provider, model: options.model, title: options.title, workspace, existingWorktreePath: existingWorktree?.path ?? null, runtimeMode, modelOptions: options.option ?? [], baseBranch: options['base-branch'] ?? null, runSetupScript: options['run-setup-script'] === true }));
  if (existing) {
    if (existing.kind !== 'launch' || existing.fingerprint !== fingerprint) throw new ControllerError('UNCERTAIN', '--request-id wurde bereits mit anderen Parametern verwendet.', { requestId });
    return recover(client, existing);
  }
  const model = resolveModel(provider, options.model);
  const modelOptions = resolveOptions(model, options.option);
  const modelSelection = { instanceId: provider.instanceId, model: model.slug, ...(modelOptions.length ? { options: modelOptions } : {}) };
  const status = existingWorktree
    ? { isRepo: true, refName: existingWorktree.branch }
    : await client.rpc('vcs.refreshStatus', { cwd: project.workspaceRoot });
  let baseBranch = options['base-branch'] ?? status.refName;
  if (workspace === 'worktree') {
    if ((protocolOf(client) === 1 && !client.environment.capabilities?.requiredWorktreeBootstrap) || !status.isRepo || !baseBranch) {
      throw new ControllerError('RESOLUTION', 'T3-gemanagter Worktree braucht ein Git-Projekt, eine Basis-Branch und native Worktree-Unterstützung.');
    }
    // Resolve the exact ref from T3; never switch the root checkout.
    const refs = await client.rpc('vcs.listRefs', { cwd: project.workspaceRoot, query: baseBranch, limit: 100 });
    if (!refs.refs.some(ref => ref.name === baseBranch)) throw new ControllerError('RESOLUTION', 'Basis-Branch nicht in T3s VCS-Katalog gefunden.');
  }
  const ids = { commandId: randomUUID(), threadId: randomUUID(), messageId: randomUUID() };
  const createdAt = new Date().toISOString();
  const receipt = { version: 1, kind: 'launch', protocol: protocolOf(client), requestId, ...ids, origin: client.origin, environmentId: client.environment.environmentId, projectId: project.id, modelSelection, promptHash: hash(prompt), fingerprint, existingWorktreePath: existingWorktree?.path ?? null, createdAt };
  const command = protocolOf(client) === 2
    ? buildV2LaunchPayload({ project, modelSelection, title: options.title, prompt, runtimeMode, branch: status.refName ?? null, ids, createdAt, workspace, baseBranch, existingWorktree, threadId: ids.threadId })
    : buildLaunchCommand({ project, modelSelection, title: options.title, prompt, runtimeMode, branch: status.refName ?? null, ids, createdAt, workspace, baseBranch, worktreePath: existingWorktree?.path ?? null });
  if (protocolOf(client) === 1 && workspace === 'worktree') command.bootstrap.runSetupScript = options['run-setup-script'] === true;
  if (!await claimReceipt(receipt)) return launch(client, { ...options, 'request-id': requestId });
  let dispatched;
  try { dispatched = await client.rpc(protocolOf(client) === 2 ? 'orchestration.launchThread' : 'orchestration.dispatchCommand', command); }
  catch (error) {
    // Bootstrap can be committed even if the client loses its response. Return
    // only read-derived recovery information, never issue another mutation.
    try { return { ...await recover(client, receipt), dispatchConfirmed: false }; }
    catch { throw new ControllerError('UNCERTAIN', 'Startantwort unklar. Mit launch --recover --request-id prüfen; nicht erneut starten.', { requestId, threadId: ids.threadId, commandId: ids.commandId, runId: null, causeCode: error.code }); }
  }
  const deadline = Date.now() + 10000;
  let result;
  do {
    try { result = await recover(client, receipt); }
    catch (error) {
      if (error.code !== 'UNCERTAIN') throw new ControllerError('UNCERTAIN', 'Dispatch bestätigt, Beobachtung fehlgeschlagen; Request-Beleg zur Recovery verwenden.', { requestId, threadId: ids.threadId, commandId: ids.commandId, sequence: dispatched?.sequence ?? null, runId: null, causeCode: error.code });
      if (!['not-found', 'message-pending'].includes(error.details.recoveryState)) throw error;
    }
    if (result?.runId || ['error', 'stopped', 'interrupted'].includes(result?.status)) break;
    await sleep(250);
  } while (Date.now() < deadline);
  if (!result) throw new ControllerError('UNCERTAIN', 'Dispatch bestätigt, Thread noch nicht lesbar.', { requestId, threadId: ids.threadId, sequence: dispatched?.sequence ?? null, runId: null });
  return { ...result, recovered: false, dispatchConfirmed: true, sequence: dispatched?.sequence ?? null, projectName: project.name };
}

export function summarizeThread(thread) {
  const approvals = new Map(), inputs = new Map(), closedApprovals = new Set(), closedInputs = new Set();
  const staleFragments = {
    'provider.approval.respond.failed': ['stale pending approval request', 'unknown pending approval request', 'unknown pending permission request', 'unknown pending codex approval request'],
    'provider.user-input.respond.failed': ['stale pending user-input request', 'unknown pending user-input request', 'unknown pending user input request', 'unknown pending codex user input request'],
  };
  for (const activity of thread.activities ?? []) {
    const payload = activity.payload, requestId = payload?.requestId;
    if (typeof requestId !== 'string' || !requestId.trim()) continue;
    const stale = staleFragments[activity.kind]?.some(fragment => String(payload.detail ?? '').toLowerCase().includes(fragment));
    if (activity.kind === 'approval.resolved' || (activity.kind === 'provider.approval.respond.failed' && stale)) { closedApprovals.add(requestId); approvals.delete(requestId); }
    if (activity.kind === 'user-input.resolved' || (activity.kind === 'provider.user-input.respond.failed' && stale)) { closedInputs.add(requestId); inputs.delete(requestId); }
    if (activity.kind === 'approval.requested' && !closedApprovals.has(requestId) && !['tool_user_input', 'auth_tokens_refresh'].includes(payload.requestType)) approvals.set(requestId, { kind: activity.kind, requestId });
    if (activity.kind === 'user-input.requested' && !closedInputs.has(requestId) && payload.questions?.some(question => typeof question.id === 'string' && typeof question.header === 'string' && typeof question.question === 'string' && Array.isArray(question.options) && (question.options.length || question.allowCustomAnswer !== false))) inputs.set(requestId, { kind: activity.kind, requestId });
  }
  const pendingInput = [...approvals.values(), ...inputs.values()];
  return { threadId: thread.id, projectId: thread.projectId, title: thread.title, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, workspace: { branch: thread.branch, worktreePath: thread.worktreePath }, status: thread.session?.status ?? 'idle', latestTurn: thread.latestTurn, runId: thread.latestTurn?.turnId ?? null, pendingInput, messages: thread.messages, lastError: thread.session?.lastError ?? null };
}
export async function send(client, id, options) {
  threadId(id);
  const requestId = requestKey(options['request-id'] ?? randomUUID());
  const existing = await readReceipt(requestId);
  if (options.recover) {
    if (!existing || existing.kind !== 'send' || existing.threadId !== id) throw new ControllerError('RESOLUTION', 'Kein passender Send-Beleg.', { requestId });
    return recover(client, existing);
  }
  const prompt = await promptFrom(options);
  const fingerprint = hash(JSON.stringify({ protocol: protocolOf(client), kind: 'send', threadId: id, promptHash: hash(prompt) }));
  if (existing) {
    if (existing.kind !== 'send' || existing.fingerprint !== fingerprint) throw new ControllerError('UNCERTAIN', '--request-id bereits anders verwendet.', { requestId });
    return recover(client, existing);
  }
  const thread = await readThread(client, id);
  if (['starting', 'running'].includes(thread.session?.status)) throw new ControllerError('ATTENTION', 'Thread arbeitet noch; zuerst wait oder stop verwenden.', { threadId: id });
  const receipt = { version: 1, kind: 'send', protocol: protocolOf(client), requestId, origin: client.origin, environmentId: client.environment.environmentId, threadId: id, projectId: thread.projectId, commandId: randomUUID(), messageId: randomUUID(), priorTurnId: thread.latestTurn?.turnId ?? null, promptHash: hash(prompt), fingerprint, createdAt: new Date().toISOString() };
  if (!await claimReceipt(receipt)) return send(client, id, { ...options, 'request-id': requestId });
  const command = protocolOf(client) === 2
    ? buildV2SendCommand({ commandId: receipt.commandId, threadId: id, messageId: receipt.messageId, text: prompt })
    : { type: 'thread.turn.start', commandId: receipt.commandId, threadId: id, message: { messageId: receipt.messageId, role: 'user', text: prompt, attachments: [] }, modelSelection: thread.modelSelection, runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode, createdAt: receipt.createdAt };
  let dispatched;
  try { dispatched = await client.rpc('orchestration.dispatchCommand', command); }
  catch (error) {
    try { return { ...await recover(client, receipt), dispatchConfirmed: false }; }
    catch { throw new ControllerError('UNCERTAIN', 'Send-Ergebnis unklar; mit send --recover prüfen.', { requestId, threadId: id, commandId: receipt.commandId, causeCode: error.code }); }
  }
  try { return { ...await recover(client, receipt), recovered: false, dispatchConfirmed: true, sequence: dispatched?.sequence ?? null }; }
  catch (error) { throw new ControllerError('UNCERTAIN', 'Send-Dispatch bestätigt, Beobachtung fehlgeschlagen; send --recover verwenden.', { requestId, threadId: id, commandId: receipt.commandId, sequence: dispatched?.sequence ?? null, causeCode: error.code }); }
}
export async function wait(client, id, options) {
  const deadline = Date.now() + Number(options['wait-timeout'] ?? 300) * 1000;
  const runId = options['run-id'];
  do {
    const thread = await readThread(client, id);
    const result = summarizeThread(thread);
    const turn = thread.latestTurn;
    const lastUser = thread.messages.findLast(message => message.role === 'user');
    const userTimestamp = Date.parse(lastUser?.createdAt), turnTimestamp = Date.parse(turn?.requestedAt);
    const queuedUser = lastUser && (!turn || !Number.isFinite(userTimestamp) || !Number.isFinite(turnTimestamp) || userTimestamp > turnTimestamp);
    if (runId && turn && turn.turnId !== runId) throw new ControllerError('ATTENTION', 'Ein anderer Turn ist aktuell; Ergebnis nicht falsch zuordnen.', { threadId: id, requestedRunId: runId, actualRunId: turn.turnId });
    if (result.status === 'error' || turn?.state === 'error') throw new ControllerError('RUN', 'T3-Turn ist fehlgeschlagen.', { threadId: id, runId: result.runId, status: result.status });
    if (['starting', 'running'].includes(result.status) && result.pendingInput.length) throw new ControllerError('ATTENTION', 'T3 benötigt eine Freigabe oder Eingabe in seiner UI.', { threadId: id, runId: result.runId, pendingInput: result.pendingInput });
    if (!queuedUser && !['starting', 'running'].includes(result.status) && turn && ['completed', 'interrupted'].includes(turn.state)) return result;
    if (result.status === 'stopped' || result.status === 'interrupted') return result;
    if (Date.now() >= deadline) throw new ControllerError('TIMEOUT', 'Wait-Zeit abgelaufen; T3 läuft unabhängig weiter.', { threadId: id, runId: result.runId, status: result.status });
    await sleep(Math.min(Number(options['poll-interval'] ?? 1) * 1000, Math.max(1, deadline - Date.now())));
  } while (true);
}
export async function stop(client, id, options) {
  threadId(id);
  const requestId = requestKey(options['request-id'] ?? randomUUID());
  const fingerprint = hash(JSON.stringify({ protocol: protocolOf(client), kind: 'stop', threadId: id, interrupt: options.interrupt === true }));
  const existing = await readReceipt(requestId);
  if (options.recover && !existing) throw new ControllerError('RESOLUTION', 'Kein Stop-Beleg gefunden.', { requestId });
  if (existing) {
    assertReceipt(client, existing);
    if (existing.kind !== 'stop' || existing.fingerprint !== fingerprint) throw new ControllerError('UNCERTAIN', '--request-id bereits anders verwendet.', { requestId });
    const thread = await readThread(client, id);
    const effectiveInterrupt = protocolOf(client) === 2 ? true : options.interrupt;
    return { requestId, threadId: id, runId: thread.latestTurn?.turnId ?? null, status: thread.session?.status ?? 'idle', recovered: true, stopConfirmed: stopSatisfied(thread, effectiveInterrupt) };
  }
  const thread = await readThread(client, id);
  if (protocolOf(client) === 1 && ['starting', 'running'].includes(thread.session?.status) && !thread.session?.activeTurnId) throw new ControllerError('ATTENTION', 'T3-Start noch ohne aktive Turn-ID; Stop nicht bestätigt. Bootstrap ggf. in T3 abbrechen oder nach Providerstart erneut prüfen.', { threadId: id });
  const receipt = { version: 1, kind: 'stop', protocol: protocolOf(client), requestId, origin: client.origin, environmentId: client.environment.environmentId, threadId: id, commandId: randomUUID(), fingerprint, createdAt: new Date().toISOString() };
  if (!await claimReceipt(receipt)) return stop(client, id, { ...options, 'request-id': requestId });
  const effectiveInterrupt = protocolOf(client) === 2 ? true : options.interrupt;
  if (stopSatisfied(thread, effectiveInterrupt)) return { requestId, threadId: id, status: thread.session?.status ?? 'idle', unchanged: true, stopConfirmed: true };
  const command = protocolOf(client) === 2
    ? buildV2StopCommand(thread, receipt.commandId)
    : { type: options.interrupt ? 'thread.turn.interrupt' : 'thread.session.stop', commandId: receipt.commandId, threadId: id, ...(options.interrupt ? { turnId: thread.session.activeTurnId } : {}), createdAt: receipt.createdAt };
  if (!command) return { requestId, threadId: id, status: thread.session?.status ?? 'idle', unchanged: true, stopConfirmed: true };
  let dispatched;
  try { dispatched = await client.rpc('orchestration.dispatchCommand', command); }
  catch (error) { throw new ControllerError('UNCERTAIN', 'Stop-Ergebnis unklar; dieselbe Request-ID liest nur den Status.', { requestId, threadId: id, causeCode: error.code }); }
  const deadline = Date.now() + 10000;
  let current;
  do {
    try { current = await readThread(client, id); }
    catch (error) { throw new ControllerError('UNCERTAIN', 'Stop-Dispatch bestätigt, Beobachtung fehlgeschlagen; stop --recover verwenden.', { requestId, threadId: id, commandId: receipt.commandId, sequence: dispatched?.sequence ?? null, causeCode: error.code }); }
    if (stopSatisfied(current, effectiveInterrupt)) break;
    await sleep(250);
  } while (Date.now() < deadline);
  return { requestId, threadId: id, commandId: receipt.commandId, runId: current.latestTurn?.turnId ?? null, sequence: dispatched?.sequence ?? null, status: current.session?.status ?? 'idle', stopConfirmed: stopSatisfied(current, effectiveInterrupt), recovered: false };
}
export function stopSatisfied(thread, interrupt = false) {
  if (!thread.session) return true;
  return (interrupt ? ['stopped', 'idle', 'interrupted', 'ready'] : ['stopped', 'idle']).includes(thread.session.status);
}
