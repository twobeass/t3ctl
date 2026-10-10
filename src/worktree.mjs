import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { ControllerError } from './errors.mjs';

async function canonicalDirectory(value, label) {
  let canonical, info;
  try {
    canonical = await realpath(value);
    info = await stat(canonical);
  } catch {
    throw new ControllerError('RESOLUTION', `${label} ist nicht erreichbar.`);
  }
  if (!info.isDirectory()) throw new ControllerError('RESOLUTION', `${label} ist kein Verzeichnis.`);
  return canonical;
}

async function gitCommonDirectory(worktreeRoot, requireLinked) {
  const dotGit = join(worktreeRoot, '.git');
  let info;
  try { info = await stat(dotGit); }
  catch { throw new ControllerError('RESOLUTION', 'Pfad ist kein Git-Worktree-Root (.git fehlt).'); }

  if (info.isDirectory()) {
    if (requireLinked) throw new ControllerError('RESOLUTION', '--existing-worktree erwartet einen verknüpften Git-Worktree, keinen Haupt-Checkout.');
    return realpath(dotGit);
  }
  if (!info.isFile()) throw new ControllerError('RESOLUTION', 'Ungültige .git-Metadaten im Worktree.');

  let pointer;
  try { pointer = await readFile(dotGit, 'utf8'); }
  catch { throw new ControllerError('RESOLUTION', 'Worktree-.git-Datei ist nicht lesbar.'); }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (!match) throw new ControllerError('RESOLUTION', 'Worktree-.git-Datei enthält keinen gitdir-Verweis.');

  let gitDir;
  try { gitDir = await realpath(resolve(worktreeRoot, match[1])); }
  catch { throw new ControllerError('RESOLUTION', 'Worktree-gitdir ist nicht erreichbar.'); }

  try {
    const common = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
    if (common) return await realpath(resolve(gitDir, common));
  } catch {}
  return gitDir;
}

async function sameCanonicalPath(left, right) {
  try { return await realpath(left) === right; }
  catch { return false; }
}

export async function validateExistingWorktree(client, project, value) {
  if (!isAbsolute(value)) throw new ControllerError('USAGE', '--existing-worktree braucht einen absoluten Pfad.');
  const path = await canonicalDirectory(value, 'Existing Worktree');
  const projectRoot = await canonicalDirectory(project.workspaceRoot, 'Projekt-Root');
  if (path === projectRoot) throw new ControllerError('RESOLUTION', 'Existing Worktree ist der Projekt-Root; dafür --workspace root verwenden.');

  const [projectCommon, worktreeCommon] = await Promise.all([
    gitCommonDirectory(projectRoot, false),
    gitCommonDirectory(path, true),
  ]);
  if (projectCommon !== worktreeCommon) {
    throw new ControllerError('RESOLUTION', 'Existing Worktree gehört nicht zum ausgewählten Projekt-Repository.');
  }

  const status = await client.rpc('vcs.refreshStatus', { cwd: path });
  if (!status?.isRepo) throw new ControllerError('RESOLUTION', 'Existing Worktree ist laut T3 kein Git-Repository.');
  if (!status.refName) throw new ControllerError('RESOLUTION', 'Detached Worktrees werden von --existing-worktree nicht unterstützt.');

  const shell = await client.get('/api/orchestration/shell');
  const busy = [];
  for (const thread of shell.threads ?? []) {
    if (!thread.worktreePath || !(await sameCanonicalPath(thread.worktreePath, path))) continue;
    if (['starting', 'running'].includes(thread.session?.status) || thread.backgroundLiveness) busy.push(thread.id);
  }
  if (busy.length) {
    throw new ControllerError('ATTENTION', 'Existing Worktree wird bereits von laufender T3-Arbeit benutzt.', { worktreePath: path, threadIds: busy });
  }
  return { path, branch: status.refName };
}
