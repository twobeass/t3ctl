import { mkdir, open, readFile, lstat, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ControllerError } from './errors.mjs';
export const JOURNAL_DIR = fileURLToPath(new URL('../.t3ctl/requests/', import.meta.url));
export function requestKey(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw new ControllerError('USAGE', '--request-id muss 1–100 Buchstaben/Ziffern/_/- enthalten.');
  return value;
}
export async function readReceipt(key, directory = JOURNAL_DIR) {
  try { return JSON.parse(await readFile(`${directory}/${requestKey(key)}.json`, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof ControllerError) throw error; throw new ControllerError('UNCERTAIN', 'Request-Beleg unlesbar; nicht erneut senden.', { requestId: key }); }
}
export async function claimReceipt(receipt, directory = JOURNAL_DIR) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new ControllerError('USAGE', 'Request-Verzeichnis muss privat und im Besitz des aktuellen Nutzers sein.');
  const path = `${directory}/${requestKey(receipt.requestId)}.json`;
  const temporary = `${directory}/.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(receipt) + '\n');
    await file.sync();
    // Publish the complete fsynced file without replacing an existing receipt.
    // A hard link is atomic and exclusive; rename would overwrite its owner.
    try { await link(temporary, path); }
    catch (error) { if (error.code === 'EEXIST') return false; throw new ControllerError('USAGE', 'Request-Beleg konnte nicht veröffentlicht werden.'); }
  } finally { await file.close(); await unlink(temporary); }
  const dir = await open(directory, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
  return true;
}
