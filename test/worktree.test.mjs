import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateExistingWorktree } from '../src/worktree.mjs';

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 't3ctl-existing-wt-'));
  const project = join(base, 'repo');
  const worktree = join(base, 'worktree');
  const admin = join(project, '.git', 'worktrees', 'feature');
  await mkdir(admin, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await writeFile(join(admin, 'commondir'), '../..\n');
  await writeFile(join(worktree, '.git'), `gitdir: ${admin}\n`);
  return { base, project, worktree, admin };
}

function clientFor(worktree, overrides = {}) {
  return {
    rpc: async (method, payload) => {
      assert.equal(method, 'vcs.refreshStatus');
      assert.equal(payload.cwd, worktree);
      return overrides.status ?? { isRepo: true, refName: 'feature/existing' };
    },
    get: async path => {
      assert.equal(path, '/api/orchestration/shell');
      return { threads: overrides.threads ?? [] };
    },
  };
}

test('existing worktree validation accepts linked worktree from the selected repository', async () => {
  const f = await fixture();
  try {
    const result = await validateExistingWorktree(clientFor(f.worktree), { workspaceRoot: f.project }, f.worktree);
    assert.deepEqual(result, { path: f.worktree, branch: 'feature/existing' });
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('existing worktree validation rejects main checkout, unrelated repository and detached head', async () => {
  const f = await fixture();
  const other = join(f.base, 'other');
  const otherAdmin = join(other, '.git', 'worktrees', 'foreign');
  const foreign = join(f.base, 'foreign');
  try {
    await mkdir(join(f.project, '.git'), { recursive: true });
    await mkdir(otherAdmin, { recursive: true });
    await mkdir(foreign, { recursive: true });
    await writeFile(join(otherAdmin, 'commondir'), '../..\n');
    await writeFile(join(foreign, '.git'), `gitdir: ${otherAdmin}\n`);
    await assert.rejects(validateExistingWorktree(clientFor(f.project), { workspaceRoot: f.project }, f.project), { code: 'RESOLUTION' });
    await assert.rejects(validateExistingWorktree(clientFor(foreign), { workspaceRoot: f.project }, foreign), { code: 'RESOLUTION' });
    await assert.rejects(validateExistingWorktree(clientFor(f.worktree, { status: { isRepo: true, refName: null } }), { workspaceRoot: f.project }, f.worktree), { code: 'RESOLUTION' });
    await assert.rejects(validateExistingWorktree(clientFor(f.worktree), { workspaceRoot: f.project }, 'relative/path'), { code: 'USAGE' });
  } finally { await rm(f.base, { recursive: true, force: true }); }
});

test('existing worktree validation blocks concurrently active T3 ownership', async () => {
  const f = await fixture();
  try {
    const client = clientFor(f.worktree, {
      threads: [{ id: 'busy', worktreePath: f.worktree, session: { status: 'running' }, backgroundLiveness: null }],
    });
    await assert.rejects(
      validateExistingWorktree(client, { workspaceRoot: f.project }, f.worktree),
      error => error.code === 'ATTENTION' && error.details.threadIds.includes('busy'),
    );
  } finally { await rm(f.base, { recursive: true, force: true }); }
});
