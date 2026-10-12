# T3 Code Orchestrator V2 control contract

Audit target: **T3 Code v0.0.46-nightly.20261010.2908**, commit
`3e94afa7c26734f525a7d8a9cdb47896e8618cf8`, Orchestration Protocol **2**.

The immutable source reference used for this audit is stored locally under
`.reference/t3code-v0.0.46-nightly.20261010.2908/` and is intentionally ignored by Git.

## Scope

This document covers only the external/headless control surface used by `t3ctl`.
T3 V2's app-owned MCP is the preferred orchestration surface **inside** a running T3
agent thread. `t3ctl` does not reimplement delegation, scheduled tasks, or internal
cross-provider orchestration.

## Verified transport

- Environment discovery remains `GET /.well-known/t3/environment`.
- V2 reports `orchestrationProtocolVersion: 2`.
- Orchestration HTTP reads require `x-t3-orchestration-protocol: 2`.
- WebSocket negotiation uses `/ws?...&orchestrationProtocol=2`.
- Effect RPC framing remains Request/Exit JSON, not JSON-RPC 2.0.
- Local authentication still uses the matching T3 CLI's
  `auth session issue` / `auth session revoke` control plane.
## Verified external reads

`GET /api/orchestration/shell` returns `OrchestrationV2ShellSnapshot`, including
projects and thread shells.

`GET /api/orchestration/threads/:threadId` returns
`OrchestrationV2ThreadDetailSnapshot` with a `projection`. The projection contains
the app thread, durable runs, provider sessions, conversation messages, runtime
requests, subagents, checkpoints, and timeline items.

`server.getConfig` remains the source for provider instances, model slugs, runtime
options, install/auth status, and live availability.

## Verified thread launch

V2 exposes Effect RPC `orchestration.launchThread`. Its input includes a caller-owned
`commandId`, optional caller-owned `threadId`, project/model/runtime/interaction
selection, a `workspaceStrategy`, and an optional initial message.

Workspace strategies are native V2 objects:

- `{type:"root", branch?}`
- `{type:"existing_worktree", worktreePath, branch?}`
- `{type:"worktree", baseRef, branch?, startFromOrigin?}`

The launch service creates the app thread, persists the initial message and durable run,
prepares the workspace, and starts the provider through T3. An existing-worktree launch
therefore needs no external Git mutation.

The native MCP `t3_thread_launch` wraps this service with an additional project-worktree allow-list check (`GitVcsDriver.listWorktreePaths`). The raw WebSocket launch RPC does not expose that wrapper. Therefore `t3ctl` allows V2 `--existing-worktree` only against a locally discovered server, where it can independently verify the linked Git common directory before dispatch. Remote V2 existing-worktree binding is rejected rather than weakening that safety property.
## Verified follow-up and stop surface

An idle external follow-up can be dispatched as `message.dispatch` with
`dispatchMode:{type:"start_immediately"}`. The V2 UI also supports queue, steer, and
restart modes, but `t3ctl` deliberately does not expose them in the initial V2 port.

The V2 Stop behavior for active work is represented by `run.interrupt` with
`holdQueue:true`. `t3ctl stop` maps to that active-run operation in V2. It does not
attempt to reproduce all provider-session lifecycle controls.

`t3ctl watch` remains read-only and uses the durable V2 thread projection. Unlike V1,
V2 retains the run list, so a watcher can resolve an explicit historical target run even
when a newer run is active. Pending runtime requests are scoped through their execution
node when possible. The current adapter intentionally uses bounded HTTP polling rather
than adding Effect-RPC stream handling solely for the watcher; timeout or client exit
never interrupts T3 work.

## Native MCP boundary

The V2 `t3-code` MCP endpoint is app-owned and injects short-lived credentials scoped
to environment, parent thread, provider instance, and provider session. It includes
provider-crossing `delegate_task`, thread launch/read/send/wait/interrupt, scheduled
tasks, and worktree tooling.

That MCP is intentionally the internal orchestration plane. `t3ctl` remains an
external bootstrap/control plane for shells, scripts, CI, Remote Commander, and other
callers that are not already running as a T3 agent.

## Idempotency and recovery

`t3ctl` allocates its thread/message/command identifiers before launch and journals
the request before mutation. A lost transport response is recovered by reading the
specific thread and matching the journaled message id/hash instead of blindly starting
another thread.

This is intentionally stricter than retrying `t3_thread_launch` from an agent: the
current V2 MCP documentation explicitly tells callers to inspect existing threads after
an ambiguous launch because that tool has no client idempotency key.
## Version policy

Protocol compatibility is not treated as semantic-version compatibility. This audit
authorizes only:

- V1: T3 Code `0.0.45`, protocol 1.
- V2: T3 Code `0.0.46-nightly.20261010.2908`, protocol 2.

A different V2 build must be contract-audited before the guard is expanded.

## Live isolated smoke

The exact npm release `t3@0.0.46-nightly.20261010.2908` was started on loopback with a fresh isolated base directory and a non-production port. The smoke verified:

- protocol-2 environment discovery;
- matching-runtime local auth with issue/revoke;
- authenticated V2 `/api/orchestration/shell` reads;
- `server.getConfig` over Effect RPC with protocol-2 WebSocket negotiation;
- `t3ctl status`, `projects`, `models`, and the integration test against that server.

The isolated server and its base directory were stopped and removed afterward. No provider session or agent turn was started. No installed production T3 runtime was patched, and no production T3 database was read or modified.
