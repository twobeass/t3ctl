# Architecture

`t3ctl` is an external control-plane client for T3 Code.

```text
outside T3                           inside T3 V2
-----------                          ------------
shell / CI / remote tool
        |
      t3ctl  --->  T3 authenticated control surfaces  --->  top-level T3 thread
                                                             |
                                                             +--> native t3-code MCP
                                                                  delegation
                                                                  scheduled tasks
                                                                  worktrees
                                                                  internal thread control
```

## Ownership

T3 owns projects, threads, provider sessions, workspaces, history, and durable run state. `t3ctl` owns only its local request journal and transport/recovery logic.

The controller never edits T3 SQLite and never starts a provider CLI directly.
## Protocol adapters

Protocol 1 uses `orchestration.dispatchCommand` with the V1 bootstrap contract.

Protocol 2 uses `orchestration.launchThread` for new top-level threads and V2 durable projections for read/wait/recovery. External follow-ups use `message.dispatch`; external stop maps to active-run interruption.

Each supported T3 build is contract-audited and version-gated. Newer semver alone is not treated as compatible.

## Ambiguous mutations

Every external mutation receives caller-generated identifiers and a local receipt before dispatch. A transport failure after send is treated as ambiguous: the controller reads T3 state and correlates the known thread/message instead of replaying the mutation.

## V2 MCP boundary

The V2 app-owned MCP is superior once a provider session already exists because T3 can scope credentials to the parent thread and provider session. Therefore provider-crossing delegation, scheduled tasks, internal fan-out, and rich worktree operations are intentionally not duplicated in `t3ctl`.