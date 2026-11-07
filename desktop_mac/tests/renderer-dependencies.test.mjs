import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureRendererDependencies } from '../infrastructure/dependencies/renderer.mjs';

test('remote renderer installs and repairs its filtered workspace against a frozen lockfile', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mac renderer deps '));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function manifest(dir, fields) {
    await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, dir, 'package.json'), JSON.stringify({ private: true, ...fields }));
  }
  const { packageManager } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  await manifest('.', { name: 'fixture', packageManager });
  await writeFile(path.join(root, '.npmrc'), 'offline=true\nstore-dir=.pnpm-store\n');
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: [desktop_mac, client, shared, server]\n');
  await manifest('shared', { name: '@ai-novel/shared', version: '1.0.0' });
  await manifest('client', { name: '@ai-novel/client', dependencies: { '@ai-novel/shared': 'workspace:*' } });
  await manifest('server', { name: '@ai-novel/server', dependencies: { '@ai-novel/shared': 'workspace:*' } });
  for (const version of ['1', '2']) {
    await manifest(`vite-${version}`, { name: 'vite', version: `${version}.0.0`, bin: { vite: 'cli.cjs' } });
    await writeFile(path.join(root, `vite-${version}/cli.cjs`), `#!/usr/bin/env node\nconsole.log('${version}');\n`, { mode: 0o755 });
  }
  const selectVite = (version) => manifest('desktop_mac', {
    name: '@ai-novel/desktop-mac', dependencies: { '@ai-novel/client': 'workspace:*' }, devDependencies: { vite: `file:../vite-${version}` },
  });
  const writeLock = () => execFileSync('pnpm', ['install', '--lockfile-only', '--no-frozen-lockfile', '--offline'], { cwd: root });
  const lockPath = path.join(root, 'pnpm-lock.yaml');
  const vite = path.join(root, 'desktop_mac/node_modules/.bin/vite');
  const viteVersion = () => execFileSync(vite, { encoding: 'utf8' }).trim();

  await selectVite('1');
  writeLock();
  const firstLock = await readFile(lockPath, 'utf8');
  assert.equal(existsSync(vite), false);
  ensureRendererDependencies(root, 'pnpm');
  assert.equal(viteVersion(), '1');
  assert.equal(await readFile(lockPath, 'utf8'), firstLock);
  assert.equal(existsSync(path.join(root, 'server/node_modules')), false);
  // A healthy tree must not invoke the installer.
  const unavailablePnpm = path.join(root, 'nonexistent-pnpm');
  ensureRendererDependencies(root, unavailablePnpm);
  await rename(path.join(root, '.runtime/desktop_mac/renderer-dependencies'), path.join(root, 'old-receipt'));
  ensureRendererDependencies(root, unavailablePnpm);

  await rename(vite, path.join(root, 'old-vite'));
  assert.throws(() => ensureRendererDependencies(root, 'true'), /安装后 desktop_mac\/node_modules\/\.bin\/vite 仍不可用/);
  await writeFile(vite, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  ensureRendererDependencies(root, 'pnpm');
  assert.equal(viteVersion(), '1');
  const sharedLink = path.join(root, 'client/node_modules/@ai-novel/shared');
  await rename(sharedLink, path.join(root, 'old-client-link'));
  ensureRendererDependencies(root, 'pnpm');
  assert.ok(existsSync(path.join(sharedLink, 'package.json')));

  await selectVite('2');
  assert.throws(() => ensureRendererDependencies(root, 'pnpm'), { stage: 'dependencies', exitCode: 2 });
  assert.equal(await readFile(lockPath, 'utf8'), firstLock);
  assert.equal(viteVersion(), '1');
  writeLock();
  const secondLock = await readFile(lockPath, 'utf8');
  ensureRendererDependencies(root, 'pnpm');
  assert.equal(viteVersion(), '2');
  assert.equal(await readFile(lockPath, 'utf8'), secondLock);

  await writeFile(lockPath, secondLock + '\n# different branch snapshot\n');
  assert.throws(() => ensureRendererDependencies(root, unavailablePnpm), { stage: 'dependencies' });
  await writeFile(lockPath, secondLock);
  assert.throws(() => ensureRendererDependencies(root, unavailablePnpm), { stage: 'dependencies' });
  ensureRendererDependencies(root, 'pnpm');
});
