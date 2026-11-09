#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig, getRepoPaths } from '../infrastructure/processes/config.mjs';
import { createLifecycle } from '../application/lifecycle/index.mjs';
import { createRuntimeAdapters } from '../application/lifecycle/runtime-adapters.mjs';
import { createStageTimer, timeLifecycleAdapters } from '../application/lifecycle/timings.mjs';

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
  const { logDir } = getRepoPaths(repoRoot);
  process.stdout.write(`[${command}] repository: ${repoRoot}\n[${command}] logs: ${logDir}\n`);
  const measure = createStageTimer(command, logDir);
  const result = await measure('总耗时', async () => {
    const config = await loadConfig({ repoRoot, env: process.env });
    const adapters = timeLifecycleAdapters(createRuntimeAdapters(config, measure), measure);
    const lifecycle = createLifecycle({ config, adapters });
    if (command === 'dev_app') return lifecycle.startLocal();
    if (command === 'app') return lifecycle.startRemote();
    if (command === 'stop_app') return lifecycle.stop();
    return lifecycle.restart(process.env.APP_MODE || undefined);
  });
  const summary = result?.status === 'started' ? '桌面已启动。'
    : result?.status === 'focused' ? '桌面已在运行，已切换到现有窗口。'
      : result?.status === 'stopped' ? (result.retained?.length ? '桌面已退出，本机创作服务暂时保留。' : '桌面已退出，辅助服务已全部关闭。')
        : null;
  if (summary) process.stdout.write(`[${command}] ${summary}\n`);
  process.stdout.write(`[${command}] ${JSON.stringify(result)}\n`);
}

const FAILURE_HINTS = {
  2: '运行条件不满足，请按下方详情补齐依赖或配置后重试。',
  3: '操作已取消，现有窗口和服务保持不变。',
  4: '无法确认相关进程属于本仓库，为安全起见没有停止任何进程。',
  5: '启动或构建没有完成，请查看日志目录中的详细原因后重试。',
};

main().catch((error) => {
  const code = Number.isInteger(error.exitCode) ? error.exitCode : 5;
  const hint = error.lockBusy
    ? '另一个桌面启动或关闭命令正在运行，请等它结束后再试。'
    : FAILURE_HINTS[code] ?? FAILURE_HINTS[5];
  process.stderr.write(`[${command}] 失败：${hint}\n[${command}] 详情（${error.stage ?? 'lifecycle'}）：${error.message}\nMAC_EXIT_CODE=${code}\n`);
  process.exitCode = code;
});
