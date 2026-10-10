import test from 'node:test';
import assert from 'node:assert/strict';
import { withClient, projects, providers } from '../src/client.mjs';

test('compatible T3: authenticated HTTP shell and native Effect RPC catalog', async () => {
  await withClient({}, async client => {
    assert.ok([1, 2].includes(client.protocol));
    assert.ok(client.auth.scopes.includes('orchestration:read'));
    const entries = await projects(client);
    assert.ok(Array.isArray(entries));
    const catalog = await providers(client);
    assert.ok(Array.isArray(catalog));
    // Run twice on the same connection to verify request correlation and reuse.
    assert.deepEqual((await providers(client)).map(p => p.instanceId), catalog.map(p => p.instanceId));
  });
});
