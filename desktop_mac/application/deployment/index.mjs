import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { loadConfig, getRepoPaths } from '../../infrastructure/processes/config.mjs';
import { acquireLock } from '../../infrastructure/processes/lock.mjs';
import { deployCurrentSource } from './local-source.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function sshInvocation(config, payload, sourceBytes) {
  // With a bundle, read exactly the Python program first and leave the binary tail on stdin.
  const python = sourceBytes === undefined ? 'python3 -' :
    `python3 -c ${quote(`import sys; exec(compile(sys.stdin.buffer.read(${sourceBytes}), "<deployment>", "exec"))`)}`;
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ClearAllForwardings=yes', config.sshTarget,
    `${python} ${quote(Buffer.from(JSON.stringify(payload)).toString('base64'))}`];
}

export async function remoteRunner({ config, payload, source, bundleFile, report = console.log }) {
  const program = Buffer.from(source);
  const args = sshInvocation(config, payload, bundleFile ? program.length : undefined);
  const child = spawn(process.platform === 'win32' ? 'ssh' : '/usr/bin/ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const completion = new Promise((resolve, reject) => {
    let output = '', errors = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (data) => { output += data.toString(); let end; while ((end = output.indexOf('\n')) >= 0) { report(output.slice(0, end)); output = output.slice(end + 1); } });
    child.stderr.on('data', (data) => { errors = (errors + data.toString()).slice(-3000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(Object.assign(new Error(`服务器部署检查未完成（SSH/部署退出码 ${code}）。${errors.trim()}`), { exitCode: [6, 7, 8].includes(code) ? code : 6 })));
  });
  async function* input() {
    yield program;
    if (bundleFile) yield* createReadStream(bundleFile);
  }
  const upload = pipeline(Readable.from(input()), child.stdin).catch((error) => {
    // An early remote refusal closes stdin. Preserve its deployment exit code.
    if (error.code !== 'EPIPE' && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') { child.kill(); throw error; }
  });
  await Promise.all([completion, upload]);
}

/** Dry run does not acquire even a local lock or upload any persistent file. */
export async function runDeployment({ repoRoot, env = process.env, dryRun = false, remote = remoteRunner, report = console.log }) {
  const config = await loadConfig({ repoRoot, env });
  let validation;
  if (env.DEPLOY_VALIDATION_FILE) validation = JSON.parse(await readFile(env.DEPLOY_VALIDATION_FILE, 'utf8'));
  const sources = await Promise.all(['common.py', 'inspection.py', 'backup.py', 'candidate.py', 'transaction.py', 'runner.py'].map((name) => readFile(path.join(directory, 'remote', name), 'utf8')));
  const quiescence = await readFile(path.join(repoRoot, 'desktop_mac/infrastructure/processes/quiescence.mjs'), 'utf8');
  const source = sources.join('\n');
  const execute = (options, output, bundleFile) => remote({ config,
    payload: { config, validation, quiescence, ...options }, source, report: output, bundleFile });
  const deploy = () => deployCurrentSource({ config, dryRun, execute, report });
  report(`[server_update] ${dryRun ? '只读预演' : '部署'} ${config.sshTarget}:${config.serverDir} · ${config.deployRef}`);
  if (dryRun) return deploy();
  const paths = getRepoPaths(config.repoRealPath);
  const owner = { repoRealPath: config.repoRealPath, operation: 'server_update' };
  const lifecycle = await acquireLock(paths.lifecycleLock, owner);
  try {
    const deployLock = await acquireLock(path.join(paths.runtimeDir, 'deploy.lock'), owner);
    try { return await deploy(); } finally { await deployLock.release(); }
  } finally { await lifecycle.release(); }
}
