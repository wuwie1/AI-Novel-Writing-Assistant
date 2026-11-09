import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { digest } from './inputs.mjs';

/** Cover every emitted chunk and resource, including the bundle signature and executable mode. */
async function outputDigest(directory, kind) {
  const files = [];
  async function walk(relative) {
    const dir = path.join(directory, relative);
    if (!(await lstat(dir)).isDirectory()) throw new Error('Invalid build directory');
    for (const name of (await readdir(dir)).sort()) {
      const child = path.join(relative, name);
      const full = path.join(directory, child);
      const info = await lstat(full);
      if (info.isDirectory()) await walk(child);
      else if (info.isFile()) files.push([child, info.mode & 0o111, digest(await readFile(full))]);
      else throw new Error(`Unsupported build artifact: ${child}`);
    }
  }
  await walk('');
  const required = kind === 'renderer' ? ['index.html'] : [
    'AI Novel Mac.app/Contents/MacOS/AI-Novel-Mac', 'AI Novel Mac.app/Contents/Info.plist',
    'AI Novel Mac.app/Contents/_CodeSignature/CodeResources', 'AI Novel Mac.app/Contents/Resources/AppIcon.icns',
  ];
  for (const file of required) {
    const info = await lstat(path.join(directory, file));
    if (!info.isFile() || !info.size) throw new Error(`Incomplete build artifact: ${file}`);
  }
  if (kind === 'native') await access(path.join(directory, required[0]), constants.X_OK);
  return digest(JSON.stringify(files));
}

/** Consumers retain immutable generation paths, even when a damaged cache entry is rebuilt. */
export async function cachedBuild({ cacheRoot, kind, key, readKey, build }) {
  const base = path.join(cacheRoot, kind);
  const receipt = path.join(base, `${key}.json`);
  let saved;
  try { saved = JSON.parse(await readFile(receipt, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (saved?.key === key && typeof saved.generation === 'string' && /^[a-f0-9-]{36}$/.test(saved.generation)
      && typeof saved.digest === 'string' && /^[a-f0-9]{64}$/.test(saved.digest)) {
    const directory = path.join(base, saved.generation);
    // An unreadable or partial output is a miss. Never repair it in place under an open window.
    if (await outputDigest(directory, kind).catch(() => null) === saved.digest) {
      return { directory, reused: true };
    }
  }
  await mkdir(base, { recursive: true, mode: 0o700 });
  const generation = randomUUID();
  const staging = path.join(base, `.${generation}.partial`);
  const directory = path.join(base, generation);
  const tempReceipt = path.join(base, `.${generation}.json`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await build(staging);
    const checksum = await outputDigest(staging, kind);
    if (await readKey(kind) !== key) throw new Error('构建期间输入发生变化，请重新运行启动命令。');
    await writeFile(tempReceipt, JSON.stringify({ key, generation, digest: checksum }), { flag: 'wx', mode: 0o600 });
    await rename(staging, directory);
    await rename(tempReceipt, receipt);
    return { directory, reused: false };
  } finally {
    // Only the private staging files created by this attempt can be removed here.
    await rm(staging, { recursive: true, force: true });
    await rm(tempReceipt, { force: true });
  }
}
