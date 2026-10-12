import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ControllerError } from './errors.mjs';
const exec = promisify(execFile);

async function resolveCliBinary(discovery, env) {
  if (env.T3CTL_T3_BIN?.trim()) return env.T3CTL_T3_BIN.trim();
  if (discovery.baseDir && discovery.serverVersion) {
    const candidate = resolve(discovery.baseDir, 'runtime', 'versions', discovery.serverVersion, 't3');
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  return 't3';
}

async function cli(binary, args) {
  try { return (await exec(binary, args, { timeout: 20000, maxBuffer: 1024 * 1024 })).stdout; }
  catch { throw new ControllerError('AUTH', 'Offizielle T3-Auth-CLI fehlgeschlagen; Prozessausgabe zum Schutz von Secrets verworfen.'); }
}
function sessionTtl(options) {
  if (!options.watchSession) return '10m';
  const watchSeconds = Number(options['watch-timeout'] ?? 3600);
  const minutes = Math.max(10, Math.ceil((watchSeconds + 120) / 60));
  return `${minutes}m`;
}
export async function authenticate(discovery, options = {}, env = process.env, runCli = cli) {
  let token = env.T3CTL_TOKEN;
  const file = options['token-file'] ?? env.T3CTL_TOKEN_FILE;
  if (file && token) throw new ControllerError('USAGE', 'Nur eine explizite Token-Quelle verwenden.');
  if (file) {
    const path = resolve(file);
    let fileHandle;
    try {
      fileHandle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await fileHandle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) || stat.uid !== process.getuid() || stat.size > 65536) throw new ControllerError('AUTH', 'Token-Datei muss eine eigene reguläre Datei mit Modus 0600 sein.');
      token = (await fileHandle.readFile('utf8')).trim();
    } catch (error) { if (error instanceof ControllerError) throw error; throw new ControllerError('AUTH', 'Token-Datei nicht sicher lesbar.'); }
    finally { await fileHandle?.close(); }
  }
  if (token !== undefined) {
    if (!token.trim() || /\s/.test(token)) throw new ControllerError('AUTH', 'Expliziter Bearer ist leer oder enthält Whitespace.');
    return { token, source: 'provided-bearer', cleanup: async () => {} };
  }
  if (!discovery.autoAuth) throw new ControllerError('AUTH', 'Auto-Auth nur für die lokal erkannte Instanz; T3CTL_TOKEN oder --token-file erforderlich.');
  const binary = await resolveCliBinary(discovery, env);
  const version = (await runCli(binary, ['--version'])).trim();
  const expectedVersion = discovery.serverVersion ?? '0.0.45';
  if (version !== `t3 v${expectedVersion}`) {
    throw new ControllerError('VERSION', 'Lokale T3-Auth-CLI passt nicht zur laufenden Serverversion.', {
      serverVersion: expectedVersion,
    });
  }
  let issued;
  try { issued = JSON.parse(await runCli(binary, ['auth', 'session', 'issue', '--base-dir', discovery.baseDir, '--ttl', sessionTtl(options), '--label', `t3ctl-${randomUUID()}`, '--json'])); }
  catch (error) { if (error instanceof ControllerError) throw error; throw new ControllerError('AUTH', 'Unerwartete T3-Auth-CLI-Antwort.'); }
  if (typeof issued.token !== 'string' || typeof issued.sessionId !== 'string') throw new ControllerError('AUTH', 'T3-Auth-CLI lieferte keinen Bearer.');
  let cleaned = false;
  return {
    token: issued.token, source: 'local-cli-ephemeral',
    cleanup: async () => {
      if (cleaned) return;
      await runCli(binary, ['auth', 'session', 'revoke', issued.sessionId, '--base-dir', discovery.baseDir]);
      cleaned = true;
    },
  };
}
