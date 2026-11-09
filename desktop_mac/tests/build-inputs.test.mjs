import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { sourceFingerprint } from '../application/lifecycle/runtime-adapters.mjs';
import { buildInputs } from '../infrastructure/builds/inputs.mjs';
import { cachedBuild } from '../infrastructure/builds/cache.mjs';

test('fingerprint traverses the actual shared package layout without depending on generated files', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const fingerprint = await sourceFingerprint(root, { toolVersions: false });
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
});

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mac-build-cache-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('renderer and native inputs invalidate independently, including the shared theme and build environment', async (t) => {
  const root = await workspace(t);
  async function put(name, value) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
  await put('desktop/package.json', '{"version":"0.1.0"}');
  await put('desktop_mac/native/Sources/App.swift', 'first');
  const read = await buildInputs(root, { toolVersions: false, env: {} });
  const native = await read('native');
  let renderer = await read('renderer');
  for (const input of ['client/tailwind.config.ts', 'pnpm-lock.yaml', 'shared/types/book.ts', 'desktop_mac/renderer/.env.production']) {
    await put(input, 'new');
    const next = await read('renderer');
    assert.notEqual(next, renderer, input);
    assert.equal(await read('native'), native, input);
    renderer = next;
  }
  await put('desktop_mac/native/Sources/App.swift', 'second');
  assert.notEqual(await read('native'), native);
  assert.equal(await read('renderer'), renderer);
  const withEnv = await buildInputs(root, { toolVersions: false, env: { VITE_WORLD_VIS_ENABLED: '0' } });
  assert.notEqual(await withEnv('renderer'), renderer);
  assert.equal(await withEnv('native'), await read('native'));
  const previousNative = await read('native');
  await put('desktop_mac/infrastructure/builds/index.mjs', 'updated build recipe');
  assert.notEqual(await read('native'), previousNative);
  assert.notEqual(await read('renderer'), renderer);
});

test('a complete generation is reused; damaged chunks, interrupted builds and changing inputs cannot replace it', async (t) => {
  const cacheRoot = await workspace(t);
  const key = 'a'.repeat(64);
  const options = {
    cacheRoot, kind: 'renderer', key, readKey: async () => key,
    build: async (dir) => {
      await writeFile(path.join(dir, 'index.html'), '<script src="chunk.js"></script>');
      await writeFile(path.join(dir, 'chunk.js'), 'good');
    },
  };
  const first = await cachedBuild(options);
  assert.equal(first.reused, false);
  const hit = await cachedBuild({ ...options, build: () => assert.fail('unexpected rebuild') });
  assert.deepEqual(hit, { ...first, reused: true });
  const receipt = path.join(cacheRoot, 'renderer', key + '.json');
  const initial = await readFile(receipt, 'utf8');
  await writeFile(path.join(first.directory, 'chunk.js'), 'oops');
  await assert.rejects(cachedBuild({ ...options, build: async () => { throw Error('compiler failed'); } }), /compiler failed/);
  await assert.rejects(cachedBuild({ ...options, readKey: async () => 'different' }), /输入发生变化/);
  assert.equal(await readFile(receipt, 'utf8'), initial);
  const repaired = await cachedBuild(options);
  assert.notEqual(repaired.directory, first.directory);
  assert.equal(await readFile(path.join(first.directory, 'chunk.js'), 'utf8'), 'oops');
  assert.equal(await readFile(path.join(repaired.directory, 'chunk.js'), 'utf8'), 'good');
  await rm(path.join(repaired.directory, 'chunk.js'));
  assert.equal((await cachedBuild(options)).reused, false);
  await writeFile(receipt, '{partial');
  const results = await Promise.all([cachedBuild(options), cachedBuild(options)]);
  const current = await cachedBuild(options);
  assert.ok(current.reused && results.some((result) => result.directory === current.directory));
});
