# t3ctl contributor guidance

This repository owns only the external T3 control CLI.

- Read the matching contract note in `docs/` before changing protocol behavior.
- Never patch an installed T3 runtime or read/write T3 SQLite directly.
- Never print credentials, bearer tokens, pairing tokens, cookies, or websocket tickets.
- Provider processes must be started by T3, never directly by this controller.
- Preserve caller workspaces and never silently fall back from a requested worktree to root.
- Journal external mutations before dispatch and never blindly replay an ambiguous mutation.
- Keep V1 and V2 behavior explicit; do not assume protocol compatibility from semver alone.
- Internal V2 orchestration belongs to T3's native MCP, not to t3ctl.

Validation: `npm test`, `git diff --check`, and a read-only integration smoke against each newly supported T3 build before expanding the version guard.

Do not commit generated `.reference/`, `.projectatlas/`, `.t3ctl/`, credentials, or local evidence.