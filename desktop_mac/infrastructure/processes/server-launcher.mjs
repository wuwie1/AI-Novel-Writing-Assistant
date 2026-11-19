import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const serverRoot = path.join(repoRoot, 'server');
// Resolve the server's watcher directly so startup only runs the API.
const tsxCli = createRequire(path.join(serverRoot, 'package.json')).resolve('tsx/cli');
const child = spawn(process.execPath, [tsxCli, 'watch', '--clear-screen=false', 'src/app.ts'], {
  cwd: serverRoot,
  env: { ...process.env, AI_NOVEL_RUNTIME: 'web', HOST: '127.0.0.1', PORT: process.env.MAC_LOCAL_API_PORT, DATABASE_URL: process.env.MAC_DATABASE_URL, AI_NOVEL_DATABASE_MODE: 'sqlite' },
  stdio: 'inherit',
});
const finish = (code) => { process.exitCode = code ?? 1; };
child.on('exit', finish);
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
