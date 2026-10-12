# Changelog

## Unreleased — 0.2.0

- Add audited T3 Orchestrator V2 / protocol 2 transport support.
- Keep V2 version gating strict to the audited build.
- Use native V2 `orchestration.launchThread` and workspace strategies.
- Normalize V2 durable projections for external read/wait/recovery.
- Add `watch`, plus `launch --watch` and `send --watch`, for read-only external completion monitoring with final-result delivery and explicit attention/failure/timeout states.
- Keep internal delegation, scheduled tasks, and cross-provider orchestration in T3's native MCP.

## 0.1.4

- Add `--existing-worktree` for externally launched V1 threads.
- Validate linked worktrees and reject active-path conflicts.

## 0.1.3

- Add provider-aware Antigravity defaults and guarded YOLO behavior.

## 0.1.0

- Initial external controller for T3 Code 0.0.45 / protocol 1.