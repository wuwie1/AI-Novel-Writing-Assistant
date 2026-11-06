import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { loadConfig, getRepoPaths } from '../../infrastructure/processes/config.mjs';
import { acquireLock } from '../../infrastructure/processes/lock.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function sshInvocation(config, payload) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', config.sshTarget,
    `python3 - ${quote(Buffer.from(JSON.stringify(payload)).toString('base64'))}`];
}

export async function remoteRunner({ config, payload, source, report = console.log }) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/ssh', sshInvocation(config, payload), { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', (data) => { output += data.toString(); let end; while ((end = output.indexOf('\n')) >= 0) { report(output.slice(0, end)); output = output.slice(end + 1); } });
    child.stderr.on('data', (data) => { errors = (errors + data.toString()).slice(-3000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(Object.assign(new Error(`服务器部署检查未完成（SSH/部署退出码 ${code}）。${errors.trim()}`), { exitCode: [6, 7, 8].includes(code) ? code : 6 })));
    child.stdin.on('error', () => {});
    child.stdin.end(source);
  });
}

/** Dry run does not acquire even a local lock or upload any persistent file. */
export async function runDeployment({ repoRoot, env = process.env, dryRun = false, remote = remoteRunner, report = console.log }) {
  const config = await loadConfig({ repoRoot, env });
  let validation = null;
  if (env.DEPLOY_VALIDATION_FILE) validation = JSON.parse(await readFile(env.DEPLOY_VALIDATION_FILE, 'utf8'));
  const sources = await Promise.all(['common.py', 'inspection.py', 'backup.py', 'candidate.py', 'transaction.py', 'runner.py'].map((name) => readFile(path.join(directory, 'remote', name), 'utf8')));
  const quiescence = await readFile(path.join(repoRoot, 'desktop_mac/infrastructure/processes/quiescence.mjs'), 'utf8');
  const payload = { config, dryRun, validation, quiescence };
  const execute = () => remote({ config, payload, source: sources.join('\n'), report });
  report(`[up_app] ${dryRun ? '只读预演' : '部署'} ${config.sshTarget}:${config.serverDir} · ${config.deployRef}`);
  if (dryRun) return execute();
  const paths = getRepoPaths(config.repoRealPath);
  const lifecycle = await acquireLock(paths.lifecycleLock, { repoRealPath: config.repoRealPath, operation: 'up_app' });
  try {
    const deploy = await acquireLock(path.join(paths.runtimeDir, 'deploy.lock'), { repoRealPath: config.repoRealPath, operation: 'up_app' });
    try { return await execute(); } finally { await deploy.release(); }
  } finally { await lifecycle.release(); }
}
