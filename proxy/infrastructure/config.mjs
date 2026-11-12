import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
export const PROXY_PORT = 14000;
export const PROXY_BASE_URL = `http://127.0.0.1:${PROXY_PORT}/v1`;

export function validateConfig(value) {
  let url;
  try { url = new URL(value?.openai?.url); } catch { throw new Error('proxy/config.toml 的 openai.url 必须是完整的 HTTP(S) API 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('openai.url 只支持不含凭据、查询参数或片段的 HTTP(S) 地址。');
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Number(url.port) === PROXY_PORT) {
    throw new Error('openai.url 不能指向代理自身。');
  }
  return { upstream: url.href.replace(/\/+$/, '') };
}

export async function loadProxyConfig(file) {
  let stdout;
  try {
    ({ stdout } = await execute('python3', ['-c',
      'import json,sys,tomllib\nwith open(sys.argv[1], "rb") as f: print(json.dumps(tomllib.load(f)))', file],
    { timeout: 5000, maxBuffer: 64 * 1024 }));
  } catch {
    // Parser errors can echo configuration text; never expose them in logs/errors.
    throw new Error('无法读取 proxy/config.toml。请确认文件存在、TOML 格式正确，并安装 Python 3.11 或更高版本。');
  }
  return validateConfig(JSON.parse(stdout));
}
