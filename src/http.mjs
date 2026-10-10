import { ControllerError } from './errors.mjs';
export async function request(origin, path, { token, method = 'GET', body, timeout = 15000, headers = {} } = {}) {
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password) throw new ControllerError('USAGE', 'HTTP-Pfad muss zur verbundenen T3-Origin gehören.');
  let response;
  try {
    response = await fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new ControllerError('NETWORK', 'T3-HTTP-Anfrage fehlgeschlagen; keine automatische Wiederholung.'); }
  if (!response.ok) {
    throw new ControllerError([401, 403].includes(response.status) ? 'AUTH' : response.status === 404 ? 'RESOLUTION' : 'NETWORK', `T3 HTTP ${response.status}.`, { status: response.status });
  }
  try { return await response.json(); } catch { throw new ControllerError('PROTOCOL', 'T3 lieferte kein gültiges JSON.'); }
}
