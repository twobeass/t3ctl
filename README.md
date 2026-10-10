# t3ctl

External/headless control CLI for [T3 Code](https://github.com/pingdotgg/t3code).

`t3ctl` is intentionally **not** a second orchestrator. It starts and controls real T3 threads from outside T3 — for shells, scripts, CI, remote-control tools, and other automation. Once an agent is running inside T3 V2, use T3's native `t3-code` MCP for subagents, cross-provider delegation, scheduled tasks, and internal orchestration.

The controller has no runtime dependencies beyond Node.js 24. T3 remains the owner of threads, providers, workspaces, and conversation history.

## Status

| t3ctl line | T3 Code | Protocol | State |
| --- | --- | --- | --- |
| v0.1.x | 0.0.45 | 1 | validated legacy controller |
| v0.2 dev | 0.0.46-nightly.20261010.2908 | 2 | source-audited; isolated V2 live smoke passed |

Version checks are deliberately strict. A different T3 build is rejected until its control contract has been reviewed.

## Commands

```sh
./t3ctl status --json
./t3ctl projects --json
./t3ctl models --json
```
```sh
./t3ctl launch \
  --project "My Project" \
  --provider codex \
  --model gpt-6.1-sol \
  --workspace root \
  --title "External task" \
  --prompt-file /tmp/task.md \
  --request-id external-task-1 \
  --json

./t3ctl thread THREAD_ID --json
./t3ctl send THREAD_ID --prompt-file /tmp/followup.md --request-id followup-1 --json
./t3ctl wait THREAD_ID --wait-timeout 300 --json
./t3ctl stop THREAD_ID --request-id stop-1 --json
```

`status`, `projects`, and `models` are read-only. Mutating commands use T3's own control surface; the controller never writes T3's database and never launches provider CLIs outside T3.

## Why this still exists in T3 V2

T3 V2 includes a native app-owned MCP server. That is the right tool **inside** a T3 agent session. Its credentials are scoped to the environment, parent thread, provider instance, and provider session.

`t3ctl` handles the opposite boundary: callers that are not already inside a T3 agent. It bootstraps a top-level thread, inspects it, sends a bounded follow-up, waits for completion, or interrupts active work. Internal fan-out should then move to the native T3 MCP.

## Workspaces

```sh
./t3ctl launch ... --workspace root
./t3ctl launch ... --workspace worktree --base-branch main
./t3ctl launch ... --existing-worktree /absolute/path/to/worktree
```

`--existing-worktree` is mutually exclusive with `--workspace`, `--base-branch`, and `--run-setup-script`. Detached worktrees are rejected. For local V1/V2 servers the controller verifies the linked Git common directory before dispatch. Remote V2 `--existing-worktree` is deliberately rejected because the raw V2 launch RPC does not expose the MCP layer's project-worktree allow-list check.

`--run-setup-script` is a V1-only compatibility switch. T3 V2 owns its native workspace setup flow. Uncommitted changes are never copied into a newly created worktree.

## Runtime modes

For Codex, Claude, and Cursor, the external default/minimum is `auto`. Explicit `approval-required` and `auto-accept-edits` are promoted to `auto`; `full-access` remains explicit opt-in.

Antigravity is provider-aware: the default is `auto-accept-edits` (`auto_edit` natively); explicit `auto` and `auto-accept-edits` are preserved; `full-access` maps to YOLO and is allowed only with a newly T3-managed `--workspace worktree`.

The worktree restriction is Git isolation, not an OS/container sandbox.

## Authentication

Local auto-auth uses the official matching T3 runtime's `auth session issue` / `auth session revoke` CLI. The temporary bearer stays in memory and is revoked after the command. This avoids crossing V1/V2 credential stores.

Remote use requires an explicit bearer through `T3CTL_TOKEN` or a private regular `--token-file` with mode 0600.

## Recovery semantics

Before a mutation, `t3ctl` writes an ignored private receipt under `.t3ctl/requests/`. It contains request/thread/message identifiers and hashes, but not the prompt or bearer.

```sh
./t3ctl launch ... --request-id build-review-42
./t3ctl launch --recover --request-id build-review-42 --json
```

If the network drops after T3 accepted the operation, recovery reads the known thread and verifies the journaled message instead of blindly replaying the launch. The same principle applies to follow-ups and stop requests.

## Development

```sh
npm test
npm run test:integration
git diff --check
```

The normal test suite does not start provider agents. Integration tests require a compatible running T3 server.

Protocol notes:

- [Architecture and ownership boundary](docs/architecture.md)
- [T3 Code 0.0.45 / protocol 1](docs/contract-v0.0.45.md)
- [T3 Code 0.0.46 nightly / protocol 2](docs/contract-v0.0.46-v2.md)

This project is an independent integration and is not an official T3 Tools product.