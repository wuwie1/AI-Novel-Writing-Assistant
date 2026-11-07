import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sshInvocation } from '../application/deployment/index.mjs';

test('SSH keeps payload separate from command syntax and requires noninteractive authentication', () => {
  const invocation = sshInvocation({ sshTarget: 'root@example.test' }, { serverDir: "/tmp/space '$()\nvalue", dryRun: true });
  assert.deepEqual(invocation.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'root@example.test']);
  assert.match(invocation[5], /^python3 - '[A-Za-z0-9+/=]+'$/);
  const decoded = JSON.parse(Buffer.from(invocation[5].split("'")[1], 'base64'));
  assert.equal(decoded.dryRun, true);
});

test('isolated deployment backup, maintenance and every artifact switch rollback', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./deployment_cases.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
