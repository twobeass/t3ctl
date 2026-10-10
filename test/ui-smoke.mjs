// Explicit browser acceptance against an existing controller test thread.
// No provider launch or prompt submission; authenticate through T3's own pairing.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { discover, guardVersion } from '../src/discovery.mjs';
import { authenticate } from '../src/auth.mjs';
import { request } from '../src/http.mjs';
import { readReceipt, JOURNAL_DIR } from '../src/journal.mjs';
import { dirname, resolve } from 'node:path';
import assert from 'node:assert/strict';

const receipt = await readReceipt(process.argv[2]);
if (!receipt) throw new Error('Existing controller request receipt required');
const discovery = await discover();
const environment = await request(discovery.origin, '/.well-known/t3/environment');
guardVersion(environment);
if (receipt.environmentId !== environment.environmentId || receipt.origin !== discovery.origin) throw new Error('Wrong T3 environment');
const auth = await authenticate(discovery);
const label = `t3ctl-ui-${randomUUID()}`;
let browser;
let stage = 'browser-start';
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const approveTestRead = process.argv.includes('--approve-test-read');
  const pairing = await request(discovery.origin, '/api/auth/pairing-token', { token: auth.token, method: 'POST', body: { label, scopes: ['orchestration:read', ...(approveTestRead ? ['orchestration:operate'] : [])] } });
  const paired = await context.request.post(`${discovery.origin}/api/auth/browser-session`, { data: { credential: pairing.credential } });
  if (!paired.ok()) throw new Error('Browser pairing failed');
  const page = await context.newPage();
  const url = `${discovery.origin}/${encodeURIComponent(environment.environmentId)}/${encodeURIComponent(receipt.threadId)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  stage = 'approval';
  if (approveTestRead) {
    // Deliberately limited to this authorized dogfood read, after server-side
    // verification. Never approve arbitrary commands from a thread.
    const snapshot = await request(discovery.origin, `/api/orchestration/threads/${encodeURIComponent(receipt.threadId)}`, { token: auth.token });
    const pending = snapshot.thread.activities.filter(a => a.kind === 'approval.requested');
    if (pending.length !== 1 || pending[0].payload?.detail !== "/bin/bash -lc 'cat README.md docs/contract-v0.0.45.md'") throw new Error('Unexpected approval');
    await page.getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 30000 });
  }
  // A marker in the submitted prompt alone is insufficient: require T3's
  // completed assistant result through the same native HTTP read surface.
  const deadline = Date.now() + 90000;
  stage = 'assistant-completion';
  let completed = false;
  while (Date.now() < deadline) {
    const snapshot = await request(discovery.origin, `/api/orchestration/threads/${encodeURIComponent(receipt.threadId)}`, { token: auth.token });
    completed = snapshot.thread.latestTurn?.state === 'completed' && snapshot.thread.messages.some(m => m.role === 'assistant' && m.text.includes('T3CTL_NATIVE_REVIEW_OK'));
    if (completed) break;
    await page.waitForTimeout(1000);
  }
  if (!completed) throw new Error('No completed assistant review');
  stage = 'rendered-result';
  await page.getByText('T3CTL_NATIVE_REVIEW_OK', { exact: false }).last().waitFor({ timeout: 30000 });
  const directory = resolve(dirname(JOURNAL_DIR), 'evidence', receipt.requestId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Never print arbitrary sidebar/chat contents or network URLs/headers.
  for (const [name, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(500);
    const body = await page.locator('body').innerText();
    const evidence = { viewport: name, nativeThread: page.url() === url, projectVisible: body.includes('T3 Controller'), providerVisible: /Codex/i.test(body), modelVisible: /GPT-6.1-Sol|gpt-6.1-sol/i.test(body), reviewMarkerVisible: body.includes('T3CTL_NATIVE_REVIEW_OK'), assistantCompleted: completed };
    assert.ok(Object.entries(evidence).every(([key, value]) => key === 'viewport' || value === true));
    // Scope screenshot to the conversation region to avoid unrelated sidebar data.
    const region = page.locator('main').last();
    if (await region.count()) await region.screenshot({ path: `${directory}/${name}.png` });
    console.log(JSON.stringify(evidence));
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('T3CTL_NATIVE_REVIEW_OK', { exact: false }).last().waitFor({ timeout: 30000 });
  console.log(JSON.stringify({ reopened: true, evidenceDirectory: directory }));
} catch {
  // Playwright error messages can contain URLs, headers or page text.
  console.error(`UI smoke failed at ${stage}; raw browser diagnostics suppressed.`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  // Revoke only the browser session created by this test, then its admin bearer.
  try {
    const clients = await request(discovery.origin, '/api/auth/clients', { token: auth.token });
    for (const client of clients.filter(entry => entry.client?.label === label)) {
      await request(discovery.origin, '/api/auth/clients/revoke', { token: auth.token, method: 'POST', body: { sessionId: client.sessionId } });
    }
  } finally { await auth.cleanup(); }
}
