export const EXIT = { USAGE: 2, DISCOVERY: 3, AUTH: 4, VERSION: 5, NETWORK: 6, RESOLUTION: 7, UNCERTAIN: 8, TIMEOUT: 9, RUN: 10, PROTOCOL: 11, ATTENTION: 12 };
export class ControllerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.exitCode = EXIT[code] ?? 1;
    this.details = details;
  }
}
export function redact(value) {
  return JSON.stringify(value, (key, entry) => /token|ticket|credential|authorization|cookie|secret|password|api.?key|bearer|jwt/i.test(key) ? '[REDACTED]' : entry)
    .replace(/Bearer\s+[^\s"\\]+/gi, 'Bearer [REDACTED]')
    .replace(/([?&#](?:wsTicket|token|credential)=)[^\s"&]+/gi, '$1[REDACTED]');
}
