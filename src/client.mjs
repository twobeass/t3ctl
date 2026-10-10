import { discover, guardVersion, protocolVersion } from './discovery.mjs';
import { authenticate } from './auth.mjs';
import { request } from './http.mjs';
import { connect } from './rpc.mjs';
import { ControllerError } from './errors.mjs';

export async function withClient(options, operation) {
  const discovery = await discover(options);
  const timeout = options.timeout ? Number(options.timeout) * 1000 : 15000;
  const environment = await request(discovery.origin, '/.well-known/t3/environment', { timeout });
  guardVersion(environment);
  const protocol = protocolVersion(environment);
  const auth = await authenticate({ ...discovery, serverVersion: environment.serverVersion }, options);
  let rpc;
  const client = {
    ...discovery, environment, protocol,
    get: path => request(discovery.origin, path, {
      token: auth.token,
      timeout,
      ...(path.startsWith('/api/orchestration/') ? { headers: { 'x-t3-orchestration-protocol': String(protocol) } } : {}),
    }),
    rpc: async (method, payload) => {
      rpc ??= await connect(discovery.origin, auth.token, timeout, options.operate === true, protocol);
      return rpc.call(method, payload);
    },
    auth: { source: auth.source },
  };
  let result, failure;
  try {
    const session = await client.get('/api/auth/session');
    if (!session.authenticated) throw new ControllerError('AUTH', 'T3 hat den Bearer nicht authentifiziert.');
    client.auth = { source: auth.source, method: session.sessionMethod, scopes: session.scopes, expiresAt: session.expiresAt };
    result = await operation(client);
  } catch (error) { failure = error; }
  finally {
    rpc?.close();
    try { await auth.cleanup(); }
    catch { if (failure) failure.details = { ...failure.details, authCleanup: 'failed; own token expires within 10m' }; else failure = new ControllerError('AUTH', 'Eigene kurzlebige Auth-Session konnte nicht widerrufen werden.', { operationCompleted: true, threadId: result?.threadId, requestId: result?.requestId, runId: result?.runId }); }
  }
  if (failure) throw failure;
  return result;
}
export function serverInfo(client) {
  return { origin: client.origin, version: client.environment.serverVersion, protocol: client.environment.orchestrationProtocolVersion ?? 1, compatible: true };
}
export async function projects(client) {
  const shell = await client.get('/api/orchestration/shell');
  if (!Array.isArray(shell.projects)) throw new ControllerError('PROTOCOL', 'T3-Shell enthält keine Projektliste.');
  return shell.projects.filter(project => !project.deletedAt).map(project => ({ id: project.id, name: project.title, workspaceRoot: project.workspaceRoot, defaultThreadEnvMode: project.defaultThreadEnvMode }));
}
export async function providers(client) {
  const config = await client.rpc('server.getConfig', {});
  guardVersion(config.environment);
  if (!Array.isArray(config.providers)) throw new ControllerError('PROTOCOL', 'T3-Config enthält keinen Providerkatalog.');
  return config.providers.map(provider => ({ instanceId: provider.instanceId, driver: provider.driver, displayName: provider.displayName, enabled: provider.enabled, installed: provider.installed, status: provider.status, authStatus: provider.auth?.status, availability: provider.availability ?? 'available', models: provider.models }));
}
