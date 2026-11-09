import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const digest = (data) => createHash('sha256').update(data).digest('hex');

// Vite follows the Mac app's aliases into client and shared and imports client/tailwind.config.ts.
const rendererInputs = [
  'desktop_mac/renderer', 'desktop_mac/tsconfig.json', 'desktop_mac/package.json',
  'desktop_mac/infrastructure/transport', 'desktop_mac/infrastructure/processes/config.mjs',
  'client/src', 'client/package.json', 'client/tsconfig.json', 'client/tailwind.config.ts', 'shared',
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'tsconfig.base.json',
  'node_modules/.pnpm/lock.yaml', '.browserslistrc', 'desktop_mac/.browserslistrc',
];

async function collectInputs(root, relative, entries, ancestors) {
  const full = path.join(root, relative);
  let info;
  try { info = await stat(full); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (info.isFile()) {
    entries.push([relative, digest(await readFile(full))]);
  } else if (info.isDirectory()) {
    const resolved = await realpath(full);
    if (ancestors.has(resolved)) throw new Error(`Circular build input: ${relative}`);
    const parents = new Set(ancestors).add(resolved);
    for (const name of (await readdir(full)).sort()) {
      if (['node_modules', '.git', '.runtime'].includes(name)) continue;
      await collectInputs(root, path.join(relative, name), entries, parents);
    }
  }
}

async function toolVersion(command, args, cwd) {
  const { stdout } = await run(command, args, { cwd, timeout: 15_000 });
  return stdout.trim();
}

/** Capture expensive tool versions once. Re-read file inputs before publishing a new build. */
export async function buildInputs(repoRoot, { development = false, toolVersions = true, pnpm = 'pnpm', env = process.env } = {}) {
  const [swift, sdk, packageManager] = toolVersions ? await Promise.all([
    toolVersion('xcrun', ['swiftc', '--version'], repoRoot),
    toolVersion('xcrun', ['--sdk', 'macosx', '--show-sdk-build-version'], repoRoot),
    development ? '' : toolVersion(pnpm, ['--version'], repoRoot),
  ]) : ['', '', ''];
  const publicEnv = Object.keys(env).filter((name) => name.startsWith('VITE_') || ['NODE_ENV', 'BROWSERSLIST', 'BROWSERSLIST_ENV'].includes(name))
    .sort().map((name) => [name, env[name]]);
  return async (kind) => {
    const version = JSON.parse(await readFile(path.join(repoRoot, 'desktop/package.json'), 'utf8')).version;
    const inputs = kind === 'native' ? ['desktop_mac/native'] : rendererInputs;
    const toolchain = kind === 'native'
      ? [swift, sdk, env.DEVELOPER_DIR, env.SDKROOT, env.TOOLCHAINS, env.MACOSX_DEPLOYMENT_TARGET]
      : [packageManager, publicEnv];
    const entries = [];
    // The orchestration also defines the compiler arguments and signing checks.
    await collectInputs(repoRoot, 'desktop_mac/infrastructure/builds/index.mjs', entries, new Set());
    for (const name of inputs) await collectInputs(repoRoot, name, entries, new Set());
    return digest(JSON.stringify([kind, version, process.platform, process.arch, process.version, toolchain, entries]));
  };
}
