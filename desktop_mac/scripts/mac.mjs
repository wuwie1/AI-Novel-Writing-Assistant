#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, getRepoPaths } from '../infrastructure/processes/config.mjs';
import { createLifecycle } from '../application/lifecycle/index.mjs';
import { createRuntimeAdapters } from '../application/lifecycle/runtime-adapters.mjs';

const command = process.argv[2];
const allowed = new Set(['dev_app', 'app', 'stop_app', 'restart_app', 'up_app']);
if (!allowed.has(command)) {
  process.stderr.write('Usage: node desktop_mac/scripts/mac.mjs <dev_app|app|stop_app|restart_app|up_app>\n');
  process.exit(2);
}

async function main() {
  if (command === 'up_app') {
    const deployment = await import('../application/deployment/index.mjs');
    if (typeof deployment.runDeployment !== 'function') throw Object.assign(new Error('Deployment module does not export runDeployment yet'), { exitCode: 6 });
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    return deployment.runDeployment({ repoRoot, env: process.env, dryRun: process.env.DRY_RUN === '1' });
  }
  if (command === 'dev_app' && process.env.APP_MODE && process.env.APP_MODE !== 'local') throw Object.assign(new Error('APP_MODE conflicts with dev_app, which always uses local mode'), { exitCode: 2 });
  if (command === 'app' && process.env.APP_MODE && process.env.APP_MODE !== 'remote') throw Object.assign(new Error('APP_MODE conflicts with app, which always uses remote mode'), { exitCode: 2 });
  if (command !== 'restart_app' && process.env.DRY_RUN) throw Object.assign(new Error('DRY_RUN is only valid with up_app'), { exitCode: 2 });
  if (command === 'restart_app' && process.env.APP_MODE && !['local', 'remote'].includes(process.env.APP_MODE)) throw Object.assign(new Error('APP_MODE must be local or remote'), { exitCode: 2 });
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const config = await loadConfig({ repoRoot, env: process.env });
  const paths = getRepoPaths(config.repoRealPath);
  process.stdout.write(`[${command}] repository: ${config.repoRealPath}\n[${command}] logs: ${paths.logDir}\n`);
  const lifecycle = createLifecycle({ config, adapters: createRuntimeAdapters(config) });
  const result = command === 'dev_app' ? await lifecycle.startLocal()
    : command === 'app' ? await lifecycle.startRemote()
      : command === 'stop_app' ? await lifecycle.stop()
        : await lifecycle.restart(process.env.APP_MODE || undefined);
  process.stdout.write(`[${command}] ${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  const code = Number.isInteger(error.exitCode) ? error.exitCode : 5;
  process.stderr.write(`[${command}] failed at ${error.stage ?? 'lifecycle'}: ${error.message}\nMAC_EXIT_CODE=${code}\n`);
  process.exitCode = code;
});
