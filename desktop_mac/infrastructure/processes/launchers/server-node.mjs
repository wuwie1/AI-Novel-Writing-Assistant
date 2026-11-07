import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** Probe only an in-memory DB. Never import the server bootstrap or open user data. */
export function selectServerNode(repoRoot, { explicit = process.env.MAC_SERVER_NODE, run = spawnSync } = {}) {
  const candidates = explicit ? [explicit] : [process.execPath, '/opt/homebrew/opt/node@22/bin/node', '/usr/local/opt/node@22/bin/node', '/opt/homebrew/opt/node@24/bin/node', '/usr/local/opt/node@24/bin/node'];
  for (const executable of [...new Set(candidates)]) {
    if (!path.isAbsolute(executable)) continue;
    const probe = run(executable, ['-e', 'const p=require("@prisma/client"); if(typeof p.PrismaClient!=="function") process.exit(1); const a=require.resolve("@prisma/adapter-better-sqlite3"); const D=require(require.resolve("better-sqlite3",{paths:[require("path").dirname(a)]})); const db=new D(":memory:"); db.prepare("select 1").get(); db.close();'], { cwd: path.join(repoRoot, 'server'), encoding: 'utf8', timeout: 10_000 });
    if (probe.status === 0) return executable;
  }
  throw Object.assign(new Error('未找到可加载 Prisma 和 SQLite 依赖的 Node。请使用 Node 22 安装/重建依赖并生成 Prisma Client，或通过 MAC_SERVER_NODE 指定已验证的绝对路径；未启动或修改数据库。'), { exitCode: 2 });
}
