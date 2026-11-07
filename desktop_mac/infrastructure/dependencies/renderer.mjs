import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { missingDirectDependencies } from '../../../scripts/workspace-dependencies.cjs';

// Vite loads the shared client and shared types directly from these workspaces.
const rendererWorkspaces = ['desktop_mac', 'client', 'shared'];
const viteBin = 'desktop_mac/node_modules/.bin/vite';
const installArgs = [
  '--filter', '@ai-novel/desktop-mac...', '--fail-if-no-match',
  'install', '--frozen-lockfile', '--prod', '--dev', '--prefer-offline',
];

function missingDependency(repoRoot) {
  for (const dir of rendererWorkspaces) {
    const packageDir = path.join(repoRoot, dir);
    const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
    const [missing] = missingDirectDependencies(packageDir, manifest);
    if (missing) return `${dir}/node_modules/${missing}`;
  }
  const vite = spawnSync(path.join(repoRoot, viteBin), ['--version'], { cwd: repoRoot, stdio: 'ignore' });
  return vite.status === 0 ? null : viteBin;
}

function digest(files) {
  const hash = createHash('sha256');
  for (const file of files) hash.update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}

function dependencyError(message) {
  return Object.assign(new Error(message), { stage: 'dependencies', exitCode: 2 });
}

export function ensureRendererDependencies(repoRoot, pnpm) {
  const lockfile = path.join(repoRoot, 'pnpm-lock.yaml');
  if (!existsSync(lockfile)) throw dependencyError('缺少 pnpm-lock.yaml，请检查当前分支的锁文件后重试。');
  const manifests = rendererWorkspaces.map(dir => path.join(repoRoot, dir, 'package.json'));
  const inputs = [lockfile, path.join(repoRoot, 'pnpm-workspace.yaml'), path.join(repoRoot, 'package.json'), ...manifests];
  const npmrc = path.join(repoRoot, '.npmrc');
  if (existsSync(npmrc)) inputs.push(npmrc);
  const wanted = digest(inputs);
  const snapshot = path.join(repoRoot, 'node_modules/.pnpm/lock.yaml');
  const receipt = path.join(repoRoot, '.runtime/desktop_mac/renderer-dependencies');
  const saved = existsSync(receipt) ? readFileSync(receipt, 'utf8') : null;
  const missing = missingDependency(repoRoot);
  // A filtered install can have a smaller installed snapshot than the repository lock.
  const verifiedState = () => `${wanted}\n${digest([snapshot])}\n`;
  mkdirSync(path.dirname(receipt), { recursive: true, mode: 0o700 });
  if (!missing && existsSync(snapshot)) {
    const current = verifiedState();
    if (saved === current) return;
    // Adopt an existing install only if pnpm linked the renderer after the checkout inputs.
    const linkedAt = Math.min(statSync(snapshot).mtimeMs, statSync(path.join(repoRoot, viteBin)).mtimeMs);
    if (saved === null && inputs.every(file => statSync(file).mtimeMs < linkedAt)) {
      writeFileSync(receipt, current);
      return;
    }
  }

  const reason = missing ? `${missing} 不可用` : '需要核对当前分支的依赖';
  process.stdout.write(`[app] ${reason}，正在按锁文件准备 Mac 桌面依赖…\n`);
  // A failed or interrupted install must be retried even if it recreated some links.
  writeFileSync(receipt, 'pending\n');
  const result = spawnSync(pnpm, installArgs, { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    throw dependencyError(`Mac 桌面依赖安装失败（${result.error?.message ?? result.signal ?? result.status}），请查看上方 pnpm 输出后重试。`);
  }
  const remaining = missingDependency(repoRoot);
  if (remaining || !existsSync(snapshot)) throw dependencyError(`安装后 ${remaining ?? 'pnpm 安装记录'} 仍不可用，请查看上方 pnpm 输出后重试。`);
  if (digest(inputs) !== wanted) throw dependencyError('安装期间依赖清单或锁文件发生变化，请重新运行启动命令。');
  writeFileSync(receipt, verifiedState());
}
