import { readFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { ControllerError } from './errors.mjs';

export const V1_VERSION = '0.0.45';
export const V2_TESTED_VERSION = '0.0.46-nightly.20261010.2908';
export function protocolVersion(environment) {
  return environment?.orchestrationProtocolVersion ?? 1;
}
export function validateUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ControllerError('USAGE', 'Ungültige Server-URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new ControllerError('USAGE', 'Server-URL muss eine HTTP(S)-Origin ohne Credentials, Pfad oder Query sein.');
  }
  return url.origin;
}
export function localOrigin(origin) {
  const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  return ['localhost', '127.0.0.1', '::1'].includes(host) || Object.values(networkInterfaces()).flat().some(entry => entry?.address === host);
}
export function guardVersion(environment) {
  const protocol = protocolVersion(environment);
  const version = environment?.serverVersion ?? null;
  const supported =
    (protocol === 1 && version === V1_VERSION) ||
    (protocol === 2 && version === V2_TESTED_VERSION);
  if (!supported) {
    throw new ControllerError('VERSION', 'T3-Version oder Orchestration-Protokoll nicht geprüft.', {
      serverVersion: version,
      protocol,
      supported: { protocol1: V1_VERSION, protocol2: V2_TESTED_VERSION },
    });
  }
}
export async function discover(options = {}, env = process.env) {
  const baseDir = resolve(options['base-dir'] ?? env.T3CODE_HOME ?? `${homedir()}/.t3`);
  let runtime;
  try { runtime = JSON.parse(await readFile(`${baseDir}/userdata/server-runtime.json`, 'utf8')); } catch {}
  const explicit = options.url ?? env.T3CTL_URL;
  if (!explicit && (!runtime || runtime.version !== 1 || !runtime.origin || !Number.isInteger(runtime.pid))) {
    throw new ControllerError('DISCOVERY', 'Keine laufende T3-Instanz im Runtime-Manifest gefunden. --url und explizite Auth verwenden.');
  }
  const origin = validateUrl(explicit ?? runtime.origin);
  const autoAuth = runtime?.version === 1 && runtime.origin === origin && localOrigin(origin);
  if (autoAuth) {
    try { process.kill(runtime.pid, 0); } catch { throw new ControllerError('DISCOVERY', 'T3-Runtime-Manifest verweist auf keinen erreichbaren Prozess.'); }
  }
  return { origin, baseDir, autoAuth };
}
