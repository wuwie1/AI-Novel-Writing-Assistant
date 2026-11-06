import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { sourceFingerprint } from '../application/lifecycle/runtime-adapters.mjs';

test('fingerprint traverses the actual shared package layout without depending on generated files', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const fingerprint = await sourceFingerprint(root, { toolVersions: false });
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
});
