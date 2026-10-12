import { parseArgs } from 'node:util';
import { isAbsolute } from 'node:path';
import { withClient, serverInfo, projects, providers } from './client.mjs';
import { ControllerError, redact } from './errors.mjs';
import { launch, readThread, summarizeThread, send, wait, watch, watchMutation, stop } from './sessions.mjs';

export function parse(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, allowPositionals: true, options: {
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, url: { type: 'string' }, 'base-dir': { type: 'string' }, 'token-file': { type: 'string' }, timeout: { type: 'string' },
    project: { type: 'string' }, provider: { type: 'string' }, model: { type: 'string' }, workspace: { type: 'string' }, title: { type: 'string' }, 'prompt-file': { type: 'string' }, prompt: { type: 'string' }, 'runtime-mode': { type: 'string' }, option: { type: 'string', multiple: true }, 'request-id': { type: 'string' }, recover: { type: 'boolean' },
    'wait-timeout': { type: 'string' }, 'watch-timeout': { type: 'string' }, 'poll-interval': { type: 'string' }, 'run-id': { type: 'string' }, watch: { type: 'boolean' }, interrupt: { type: 'boolean' },
    'base-branch': { type: 'string' }, 'run-setup-script': { type: 'boolean' }, 'existing-worktree': { type: 'string' },
  } }); } catch { throw new ControllerError('USAGE', 'Ungültige Argumente; t3ctl --help verwenden.'); }
  if (parsed.values.timeout !== undefined && (!Number.isFinite(Number(parsed.values.timeout)) || Number(parsed.values.timeout) <= 0 || Number(parsed.values.timeout) > 3600)) throw new ControllerError('USAGE', '--timeout muss zwischen 0 und 3600 Sekunden liegen.');
  const command = parsed.positionals[0], control = ['thread', 'send', 'wait', 'watch', 'stop'].includes(command);
  if (!parsed.values.help && (!['status', 'projects', 'models', 'launch', 'thread', 'send', 'wait', 'watch', 'stop'].includes(command) || parsed.positionals.length !== (control ? 2 : 1))) throw new ControllerError('USAGE', 'Erwartet: t3ctl status|projects|models|launch oder thread|send|wait|watch|stop THREAD_ID.');
  if (parsed.values.recover && !parsed.values['request-id']) throw new ControllerError('USAGE', '--recover braucht --request-id.');
  for (const [key, maximum] of [['wait-timeout', 540], ['watch-timeout', 86400], ['poll-interval', 60]]) if (parsed.values[key] !== undefined && (!Number.isFinite(Number(parsed.values[key])) || Number(parsed.values[key]) <= 0 || Number(parsed.values[key]) > maximum)) throw new ControllerError('USAGE', `Ungültiger --${key} (max. ${maximum}s).`);
  const global = ['json', 'help', 'url', 'base-dir', 'token-file', 'timeout'];
  const allowed = { launch: ['project', 'provider', 'model', 'workspace', 'existing-worktree', 'title', 'prompt-file', 'prompt', 'runtime-mode', 'option', 'request-id', 'recover', 'base-branch', 'run-setup-script', 'watch', 'watch-timeout', 'poll-interval'], send: ['prompt-file', 'prompt', 'request-id', 'recover', 'watch', 'watch-timeout', 'poll-interval'], stop: ['request-id', 'recover', 'interrupt'], wait: ['wait-timeout', 'poll-interval', 'run-id'], watch: ['watch-timeout', 'poll-interval', 'run-id'] };
  if (!parsed.values.help) for (const key of Object.keys(parsed.values)) if (![...global, ...(allowed[command] ?? [])].includes(key)) throw new ControllerError('USAGE', `--${key} ist für ${command} nicht zulässig.`);
  if (!parsed.values.help && ['launch', 'send'].includes(command) && !parsed.values.watch && (parsed.values['watch-timeout'] || parsed.values['poll-interval'])) throw new ControllerError('USAGE', '--watch-timeout/--poll-interval bei launch/send brauchen --watch.');
  if (!parsed.values.help && parsed.positionals[0] === 'launch') {
    if (parsed.values.recover) {
      if (!parsed.values['request-id']) throw new ControllerError('USAGE', '--recover braucht --request-id.');
    } else {
      for (const key of ['project', 'provider', 'model', 'title']) if (!parsed.values[key]?.trim()) throw new ControllerError('USAGE', `launch braucht --${key}.`);
    }
    if (parsed.values.workspace && !['root', 'worktree'].includes(parsed.values.workspace)) throw new ControllerError('USAGE', '--workspace muss root oder worktree sein.');
    if (parsed.values['existing-worktree'] !== undefined && !parsed.values['existing-worktree'].trim()) throw new ControllerError('USAGE', '--existing-worktree darf nicht leer sein.');
    if (parsed.values['existing-worktree'] && !isAbsolute(parsed.values['existing-worktree'])) throw new ControllerError('USAGE', '--existing-worktree braucht einen absoluten Pfad.');
    if (parsed.values['existing-worktree'] && parsed.values.workspace) throw new ControllerError('USAGE', '--existing-worktree und --workspace sind gegenseitig exklusiv.');
    if (parsed.values['existing-worktree'] && (parsed.values['base-branch'] || parsed.values['run-setup-script'])) throw new ControllerError('USAGE', '--existing-worktree kann nicht mit --base-branch oder --run-setup-script kombiniert werden.');
    if ((parsed.values['base-branch'] || parsed.values['run-setup-script']) && parsed.values.workspace !== 'worktree') throw new ControllerError('USAGE', '--base-branch und --run-setup-script brauchen --workspace worktree.');
  }
  if (parsed.values['runtime-mode'] && !['approval-required', 'auto-accept-edits', 'auto', 'full-access'].includes(parsed.values['runtime-mode'])) throw new ControllerError('USAGE', 'Ungültiger --runtime-mode.');
  return { command, id: parsed.positionals[1], options: parsed.values };
}
export async function main(argv = process.argv.slice(2)) {
  let json = argv.includes('--json');
  try {
    const { command, id, options } = parse(argv);
    json = options.json;
    if (options.help) {
      console.log(`t3ctl status|projects|models [--json]
t3ctl launch --project NAME --provider DRIVER_OR_INSTANCE --model SLUG
  (--workspace root|worktree | --existing-worktree ABSOLUTE_PATH)
  --title TITLE --prompt-file FILE
  [--runtime-mode approval-required|auto-accept-edits|auto|full-access]
  (default: auto; Antigravity default: auto-accept-edits;
   Antigravity full-access/yolo requires --workspace worktree)
  [--option id=value] [--request-id KEY] [--base-branch REF] [--run-setup-script]
  [--watch] [--watch-timeout SECONDS] [--poll-interval SECONDS]
  (--base-branch/--run-setup-script nur mit --workspace worktree)
t3ctl launch --recover --request-id KEY [--watch]
t3ctl thread THREAD_ID
t3ctl send THREAD_ID --prompt-file FILE [--request-id KEY] [--watch]
t3ctl send THREAD_ID --recover --request-id KEY [--watch]
t3ctl wait THREAD_ID [--run-id ID] [--wait-timeout SECONDS] [--poll-interval SECONDS]
t3ctl watch THREAD_ID [--run-id ID] [--watch-timeout SECONDS] [--poll-interval SECONDS]
  launch/send --watch nutzen denselben Watcher (Default 3600s, max. 86400s)
t3ctl stop THREAD_ID [--interrupt] [--request-id KEY] [--recover]
Global: --json --url ORIGIN --base-dir DIR --token-file FILE --timeout SECONDS`);
      return;
    }
    const result = await withClient({ ...options, watchSession: command === 'watch' || options.watch === true, operate: ['launch', 'send', 'stop'].includes(command) && !options.recover }, async client => {
      const base = { server: serverInfo(client) };
      if (command === 'launch') return { ...base, ...await watchMutation(client, await launch(client, options), options) };
      if (command === 'thread') return { ...base, ...summarizeThread(await readThread(client, id)) };
      if (command === 'send') return { ...base, ...await watchMutation(client, await send(client, id, options), options) };
      if (command === 'wait') return { ...base, ...await wait(client, id, options) };
      if (command === 'watch') return { ...base, ...await watch(client, id, options) };
      if (command === 'stop') return { ...base, ...await stop(client, id, options) };
      if (command === 'status') { await client.rpc('server.getConfig', {}); return { ...base, connected: true, auth: client.auth }; }
      if (command === 'projects') return { ...base, projects: await projects(client) };
      return { ...base, providers: await providers(client) };
    });
    if (json) console.log(redact({ ok: true, ...result }));
    else {
      console.log(`T3 ${result.server.version} · ${result.server.origin} · Protokoll ${result.server.protocol}`);
      if (command === 'status') console.log(`Verbunden · ${result.auth.method} · Scopes: ${result.auth.scopes.join(', ')}`);
      if (command === 'projects') for (const project of result.projects) console.log(`${project.name}\t${project.id}\t${project.workspaceRoot}`);
      if (command === 'models') for (const provider of result.providers) {
        console.log(`${provider.displayName ?? provider.instanceId} [${provider.driver}] · ${provider.instanceId} · ${provider.status}`);
        for (const model of provider.models) console.log(`  ${model.slug}\t${model.name}`);
      }
      if (['launch', 'thread', 'send', 'wait', 'watch', 'stop'].includes(command)) {
        console.log(`Thread ${result.threadId}\nRun ${result.runId ?? 'noch nicht zugewiesen'}${result.requestId ? `\nRequest ${result.requestId}` : ''}\nStatus ${result.status}${result.recovered ? ' · aus T3 gelesen' : ''}${result.watchState ? `\nWatch ${result.watchState}` : ''}`);
        if (result.result) console.log(`\n[result]\n${JSON.parse(redact({ text: result.result })).text}`);
        for (const message of result.messages ?? []) console.log(`\n[${message.role}]\n${JSON.parse(redact({ text: message.text })).text}`);
      }
    }
  } catch (error) {
    const safe = error instanceof ControllerError ? error : new ControllerError('PROTOCOL', 'Unerwarteter Controller-Fehler; Rohdaten unterdrückt.');
    const result = { ok: false, error: { code: safe.code, message: safe.message, ...safe.details } };
    (json ? console.log : console.error)(redact(result));
    process.exitCode = safe.exitCode;
  }
}
