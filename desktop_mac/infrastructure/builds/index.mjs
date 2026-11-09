import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { buildInputs, digest } from './inputs.mjs';
import { cachedBuild } from './cache.mjs';

async function identify(repoRoot, options) {
  const readKey = await buildInputs(repoRoot, options);
  const [nativeKey, rendererKey] = await Promise.all([
    readKey('native'), options.development ? null : readKey('renderer'),
  ]);
  return { readKey, nativeKey, rendererKey, fingerprint: digest(JSON.stringify([nativeKey, rendererKey])) };
}

export async function sourceFingerprint(repoRoot, options = {}) {
  return (await identify(repoRoot, options)).fingerprint;
}

export async function prepareDesktopBuild({ repoRoot, buildsDir, mode, development, pnpm, measure }) {
  const { readKey, nativeKey, rendererKey, fingerprint } = await measure('计算构建指纹',
    () => identify(repoRoot, { development, pnpm }));
  const cacheRoot = path.join(buildsDir, 'cache-v1');
  const describe = (result) => result.reused ? '命中缓存' : '构建完成';
  function run(executable, args, env = process.env) {
    const child = spawnSync(executable, args, { cwd: repoRoot, env, stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) throw new Error(`${path.basename(executable)} 构建检查失败（${child.status ?? child.signal}）`);
  }
  let rendererRoot = path.join(repoRoot, 'desktop_mac/renderer');
  if (!development) {
    const renderer = await measure('前端界面', () => cachedBuild({
      cacheRoot, kind: 'renderer', key: rendererKey, readKey,
      build: (output) => run(pnpm, ['--filter', '@ai-novel/desktop-mac', 'run', 'build:renderer'],
        { ...process.env, MAC_RENDERER_OUT_DIR: output }),
    }), describe);
    rendererRoot = renderer.directory;
  }
  const native = await measure('Swift 窗口', () => cachedBuild({
    cacheRoot, kind: 'native', key: nativeKey, readKey,
    build: (output) => {
      run(process.execPath, [path.join(repoRoot, 'desktop_mac/native/build.mjs'), '--out-dir', output]);
      run('/usr/bin/codesign', ['--verify', '--strict', path.join(output, 'AI Novel Mac.app')]);
    },
  }), describe);
  const appPath = path.join(native.directory, 'AI Novel Mac.app');
  return { fingerprint, rendererRoot, appPath, executable: path.join(appPath, 'Contents/MacOS/AI-Novel-Mac'), development, mode };
}
