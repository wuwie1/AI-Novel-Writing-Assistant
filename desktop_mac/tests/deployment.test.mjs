import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDeployment, sshInvocation } from '../application/deployment/index.mjs';

test('SSH keeps payload separate from command syntax and requires noninteractive authentication', () => {
  const invocation = sshInvocation({ sshTarget: 'root@example.test' }, { serverDir: "/tmp/space '$()\nvalue", dryRun: true });
  assert.deepEqual(invocation.slice(0, -1), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ClearAllForwardings=yes', 'root@example.test']);
  assert.match(invocation.at(-1), /^python3 - '[A-Za-z0-9+/=]+'$/);
  const decoded = JSON.parse(Buffer.from(invocation.at(-1).split("'")[1], 'base64'));
  assert.equal(decoded.dryRun, true);
});

test('server update pins an unpublished commit and imports only its verified bundle into a different checkout', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'server update '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const local = path.join(temporary, 'local'), server = path.join(temporary, 'server');
  const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await mkdir(local);
  git(local, 'init', '-b', 'ai');
  git(local, 'config', 'user.name', 'Fixture');
  git(local, 'config', 'user.email', 'fixture@example.test');
  git(local, 'remote', 'add', 'origin', 'https://github.com/wuwie1/AI-Novel-Writing-Assistant.git');
  await writeFile(path.join(local, '.gitignore'), '.runtime/\n');
  git(local, 'add', '.gitignore');
  git(local, 'commit', '-m', 'baseline');
  const base = git(local, 'rev-parse', 'HEAD');
  git(temporary, 'clone', '--no-local', local, server);
  git(local, 'commit', '--allow-empty', '-m', 'unpublished change');
  const sha = git(local, 'rev-parse', 'HEAD');
  const validation = path.join(temporary, 'validation.json');
  await writeFile(validation, JSON.stringify({ sha, ref: 'origin/ai', evidence: 'fixture', passed: ['client-build', 'server-build', 'targeted-tests'] }));
  let applications = 0;
  const remote = async ({ config, payload, bundleFile, report, source }) => {
    assert.equal(payload.currentSha, sha);
    if (payload.dryRun) {
      assert.equal(bundleFile, undefined);
      report(JSON.stringify({ stage: 'inspection', candidate: sha, current: base, known: false }));
      return;
    }
    applications += 1;
    assert.equal(payload.serverBase, base);
    assert.equal(payload.withBundle, true);
    const program = Buffer.from(source.split("if __name__ == '__main__':")[0] +
      '\np = json.loads(base64.b64decode(sys.argv[1]))\nprint(candidate_commit(pathlib.Path(p["config"]["serverDir"]), p["currentSha"], import_bundle=True))\n');
    const input = Buffer.concat([program, await readFile(bundleFile)]);
    const importBundle = (candidate) => spawnSync('sh', ['-c', sshInvocation(config, candidate, program.length).at(-1)], {
      input, encoding: 'utf8',
    });
    const mismatch = importBundle({ ...payload, currentSha: base });
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /Git bundle 与本次提交不符/);
    assert.notEqual(spawnSync('git', ['-C', server, 'cat-file', '-e', sha]).status, 0);
    const result = importBundle(payload);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), sha);
    assert.equal(git(server, 'rev-parse', 'HEAD'), base);
    assert.equal(git(server, 'cat-file', '-t', sha), 'commit');
    report(JSON.stringify({ stage: 'deployed', sha, backup: 'fixture-backup' }));
  };
  // The fixture uses the real deployment Python and quiescence source from the repository.
  await mkdir(path.join(local, 'desktop_mac/infrastructure/processes'), { recursive: true });
  const quiescence = await readFile(new URL('../infrastructure/processes/quiescence.mjs', import.meta.url));
  await writeFile(path.join(local, 'desktop_mac/infrastructure/processes/quiescence.mjs'), quiescence);
  await writeFile(path.join(local, '.git/info/exclude'), '/desktop_mac/\n');
  await mkdir(path.join(server, '.runtime'));
  const options = { repoRoot: local, env: { SERVER_DIR: server, DEPLOY_VALIDATION_FILE: validation }, report: () => {}, remote };
  assert.equal((await runDeployment({ ...options, dryRun: true })).candidate, sha);
  assert.equal(applications, 0);
  await assert.rejects(runDeployment({ ...options, env: { SERVER_DIR: server } }), /DEPLOY_VALIDATION_FILE/);
  assert.equal((await runDeployment(options)).sha, sha);
  assert.equal(applications, 1);
  await writeFile(path.join(local, 'pending-edit'), 'keep');
  await assert.rejects(runDeployment(options), /未提交/);
  assert.equal(applications, 1);
});

test('isolated deployment backup, maintenance and every artifact switch rollback', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./deployment_cases.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
