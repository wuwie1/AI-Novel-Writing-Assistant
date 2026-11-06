import { mkdir, open, readdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

/** Single writer per stdout/stderr stream; bounded files include the current file. */
export async function appendLogChunk(filePath, chunk, { maxBytes = 10 * 1024 * 1024, retain = 5 } = {}) {
  let remaining = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  while (remaining.length) {
    let size = 0;
    try { size = (await stat(filePath)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (size >= maxBytes) {
      for (let index = retain - 1; index >= 1; index -= 1) {
        try { await rename(index === 1 ? filePath : `${filePath}.${index - 1}`, `${filePath}.${index}`); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      size = 0;
    }
    const length = Math.min(remaining.length, maxBytes - size);
    const handle = await open(filePath, 'a', 0o600);
    try { await handle.write(remaining.subarray(0, length)); } finally { await handle.close(); }
    remaining = remaining.subarray(length);
  }
}

export async function appendRoleLog(logDir, role, line, { maxBytes = 10 * 1024 * 1024, retain = 5 } = {}) {
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(logDir, `${role}.log`);
  try { if ((await stat(filePath)).size >= maxBytes) {
    for (let index = retain - 1; index >= 1; index -= 1) {
      const from = index === 1 ? filePath : `${filePath}.${index - 1}`;
      const to = `${filePath}.${index}`;
      try { await rename(from, to); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const handle = await open(filePath, 'a', 0o600);
  try { await handle.write(`${new Date().toISOString()} ${String(line).replace(/[\r\n]+/g, ' ')}\n`); } finally { await handle.close(); }
  const files = (await readdir(logDir)).filter((name) => name === `${role}.log` || name.startsWith(`${role}.log.`));
  return { filePath, retained: files.length };
}
