import { ControllerError } from './errors.mjs';
import { request } from './http.mjs';

export function decodeFrames(data) {
  const result = JSON.parse(data);
  return Array.isArray(result) ? result : [result];
}
export class RpcClient {
  constructor(socket, timeout = 15000, operate = false, protocol = 1) {
    this.socket = socket;
    this.timeout = timeout;
    this.operate = operate;
    this.protocol = protocol;
    this.pending = new Map();
    this.nextId = 0;
    socket.addEventListener('message', event => {
      try {
        for (const frame of decodeFrames(event.data)) {
          if (frame._tag === 'Pong') continue;
          const pending = this.pending.get(String(frame.requestId));
          if (frame._tag === 'Defect') { this.fail(new ControllerError('PROTOCOL', 'T3 RPC meldet einen Defect.')); continue; }
          if (!pending) continue;
          if (frame._tag !== 'Exit') throw new Error('Unexpected unary frame');
          this.pending.delete(String(frame.requestId));
          clearTimeout(pending.timer);
          if (frame.exit?._tag === 'Success') pending.resolve(frame.exit.value);
          else pending.reject(new ControllerError('PROTOCOL', 'T3 RPC hat die Anfrage abgelehnt.', { method: pending.method, serverError: frame.exit?.cause?.find(c => c._tag === 'Fail')?.error?._tag ?? 'unknown' }));
        }
      } catch { this.fail(new ControllerError('PROTOCOL', 'Ungültige T3-RPC-Antwort.')); }
    });
    socket.addEventListener('close', () => this.fail(new ControllerError('NETWORK', 'T3-WebSocket geschlossen; keine automatische Wiederholung.')));
    socket.addEventListener('error', () => this.fail(new ControllerError('NETWORK', 'T3-WebSocket fehlgeschlagen.')));
    this.ping = setInterval(() => { if (socket.readyState === 1) socket.send(JSON.stringify({ _tag: 'Ping' })); }, 20000);
    this.ping.unref();
  }
  fail(error) {
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
  }
  call(method, payload = {}) {
    const allowed = ['server.getConfig', 'vcs.refreshStatus', 'vcs.listRefs'];
    if (this.operate) {
      allowed.push('orchestration.dispatchCommand');
      if (this.protocol === 2) allowed.push('orchestration.launchThread');
    }
    if (!allowed.includes(method)) {
      throw new ControllerError('USAGE', 'RPC-Methode nicht im Controller-Vertrag.');
    }
    if (this.socket.readyState !== 1) return Promise.reject(new ControllerError('NETWORK', 'T3-WebSocket ist nicht offen.'));
    const id = String(++this.nextId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ControllerError('NETWORK', 'T3-RPC-Timeout; Ergebnis möglicherweise bereits übernommen.', { method }));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.socket.send(JSON.stringify({ _tag: 'Request', id, tag: method, payload, headers: [] })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new ControllerError('NETWORK', 'T3-RPC-Senden fehlgeschlagen.')); }
    });
  }
  close() { clearInterval(this.ping); this.fail(new ControllerError('NETWORK', 'RPC-Client geschlossen.')); this.socket.close(); }
}
export async function connect(origin, token, timeout = 15000, operate = false, protocol = 1) {
  const ticket = await request(origin, '/api/auth/websocket-ticket', { token, method: 'POST', timeout });
  if (typeof ticket.ticket !== 'string' || !ticket.ticket) throw new ControllerError('PROTOCOL', 'Kein T3-WebSocket-Ticket.');
  const url = new URL('/ws', origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('wsTicket', ticket.ticket);
  url.searchParams.set('orchestrationProtocol', String(protocol));
  let socket;
  try { socket = new WebSocket(url); } catch { throw new ControllerError('NETWORK', 'T3-WebSocket konnte nicht angelegt werden.'); }
  const client = new RpcClient(socket, timeout, operate, protocol);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new ControllerError('NETWORK', 'T3-WebSocket-Verbindungs-Timeout.')), timeout);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      for (const event of ['error', 'close']) socket.addEventListener(event, () => { clearTimeout(timer); reject(new ControllerError('NETWORK', 'T3-WebSocket-Verbindung fehlgeschlagen.')); }, { once: true });
    });
    return client;
  } catch (error) { client.close(); throw error; }
}
