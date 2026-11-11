import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { inspectSqliteQuiescence, QUIESCENCE_TABLE_SCHEMA } from '../infrastructure/processes/quiescence.mjs';

const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/src/prisma/schema.sqlite.prisma');

async function scalarColumns() {
  const source = await readFile(schemaPath, 'utf8');
  const enums = new Set([...source.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((match) => match[1]));
  const scalarTypes = new Set(['String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', ...enums]);
  const models = new Map();
  for (const match of source.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const columns = [];
    for (const line of match[2].split(/\r?\n/)) {
      const field = line.match(/^\s{2}(\w+)\s+([A-Za-z]\w*)(\??)(?:\s+.*)?$/);
      if (field && scalarTypes.has(field[2])) columns.push({ name: field[1], sqlType: field[2] === 'Int' || field[2] === 'Boolean' ? 'INTEGER' : field[2] === 'Float' ? 'REAL' : 'TEXT' });
    }
    models.set(match[1], columns);
  }
  return models;
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mac-quiescence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'tasks.sqlite');
  const models = await scalarColumns();
  for (const [table, expected] of Object.entries(QUIESCENCE_TABLE_SCHEMA)) {
    const actual = models.get(table);
    assert.ok(actual, `real SQLite Prisma schema contains ${table}`);
    const actualNames = actual.map((column) => column.name);
    assert.deepEqual(expected.filter((column) => !actualNames.includes(column)), [], `${table} manifest columns match the real schema`);
  }
  const definitions = [...models].map(([table, actual]) => {
    return `CREATE TABLE "${table}" (${actual.map(({ name, sqlType }) => `"${name}" ${sqlType}`).join(',')});`;
  }).join('\n');
  const created = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript(sys.stdin.read()); c.commit(); c.close()', dbPath], { input: definitions, encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  return { dbPath, dir };
}

test('quiescence scan accepts a complete read-only schema with only manual approval/pause rows', async (t) => {
  const { dbPath } = await fixture(t);
  const seed = spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO AgentApproval(status) VALUES ('pending')"); c.execute("INSERT INTO DirectorNextRunControl(status,leaseOwner,leaseExpiresAt,heartbeatAt) VALUES ('paused',NULL,NULL,NULL)"); c.commit(); c.close()`, dbPath]);
  assert.equal(seed.status, 0);
  const result = await inspectSqliteQuiescence({ dbPath });
  assert.equal(result.safeToStop, true, JSON.stringify(result));
  assert.equal(result.checkedTables.length, Object.keys(QUIESCENCE_TABLE_SCHEMA).length);
});

test('completed creation handoffs are quiescent without changing the confirmation record', async (t) => {
  const { dbPath } = await fixture(t);
  const seeded = spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO CreationStudioConfirmation(status) VALUES ('handed_off')"); c.commit(); c.close()`, dbPath]);
  assert.equal(seeded.status, 0);
  const before = await readFile(dbPath);
  const result = await inspectSqliteQuiescence({ dbPath });
  assert.equal(result.safeToStop, true, JSON.stringify(result));
  assert.deepEqual(await readFile(dbPath), before);
});

test('a completed creation handoff does not hide active successor work', async (t) => {
  const { dbPath } = await fixture(t);
  const seeded = spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO CreationStudioConfirmation(status) VALUES ('handed_off')"); c.execute("INSERT INTO NovelWorkflowTask(status,pendingManualRecovery,attemptCount,maxAttempts,heartbeatAt) VALUES ('running',0,1,3,NULL)"); c.commit(); c.close()`, dbPath]);
  assert.equal(seeded.status, 0);
  const result = await inspectSqliteQuiescence({ dbPath });
  assert.equal(result.safeToStop, false);
  assert.ok(result.blockers.some(item => item.table === 'NovelWorkflowTask' && item.kind === 'active_task'));
  assert.equal(result.blockers.some(item => item.table === 'CreationStudioConfirmation'), false);
});

test('claimed confirmations and unknown or misplaced handoff statuses still block shutdown', async (t) => {
  for (const [table, status, kind] of [
    ['CreationStudioConfirmation', 'claimed', 'active_task'],
    ['CreationStudioConfirmation', 'future_status', 'unknown_status'],
    ['AgentRun', 'handed_off', 'unknown_status'],
  ]) {
    const { dbPath } = await fixture(t);
    const seeded = spawnSync('python3', ['-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO "+sys.argv[2]+"(status) VALUES (?)", (sys.argv[3],)); c.commit(); c.close()', dbPath, table, status]);
    assert.equal(seeded.status, 0);
    const result = await inspectSqliteQuiescence({ dbPath });
    assert.equal(result.safeToStop, false, `${table}:${status}`);
    assert.ok(result.blockers.some(item => item.table === table && item.kind === kind), JSON.stringify(result));
  }
});

test('quiescence scan rejects active work, leases, automatic retries and incomplete coverage', async (t) => {
  const { dbPath } = await fixture(t);
  let insert = spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO NovelWorkflowTask(status,pendingManualRecovery,attemptCount,maxAttempts,heartbeatAt) VALUES ('running',0,1,3,NULL)"); c.commit(); c.close()`, dbPath]);
  assert.equal(insert.status, 0);
  let result = await inspectSqliteQuiescence({ dbPath });
  assert.equal(result.safeToStop, false);
  assert.ok(result.blockers.some((item) => item.table === 'NovelWorkflowTask'));

  spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("DELETE FROM NovelWorkflowTask"); c.execute("INSERT INTO GenerationJob(status,pendingManualRecovery,retryCount,maxRetries,executionOwner,executionLeaseExpiresAt) VALUES ('failed',0,0,2,NULL,NULL)"); c.commit(); c.close()`, dbPath]);
  result = await inspectSqliteQuiescence({ dbPath });
  assert.equal(result.safeToStop, false);
  assert.ok(result.blockers.some((item) => item.kind === 'automatic_retry_candidate'), JSON.stringify(result));

  spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("DELETE FROM GenerationJob"); c.execute("INSERT INTO DirectorNextRunControl(status,leaseOwner,leaseExpiresAt,heartbeatAt) VALUES ('paused','worker','4102444800000',NULL)"); c.commit(); c.close()`, dbPath]);
  result = await inspectSqliteQuiescence({ dbPath });
  assert.equal(result.safeToStop, false);
  assert.ok(result.blockers.some((item) => item.kind === 'active_lease'));

  spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("CREATE TABLE FutureBackgroundTask(status TEXT)"); c.close()`, dbPath]);
  result = await inspectSqliteQuiescence({ dbPath });
  assert.equal(result.safeToStop, false);
  assert.ok(result.blockers.some((item) => item.kind === 'unknown_tables'));
});

test('missing SQLite files and missing covered tables fail closed', async (t) => {
  const { dbPath, dir } = await fixture(t);
  const missing = await inspectSqliteQuiescence({ dbPath: path.join(dir, 'missing.sqlite') });
  assert.equal(missing.safeToStop, false);
  spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("DROP TABLE AgentRun"); c.close()`, dbPath]);
  const result = await inspectSqliteQuiescence({ dbPath });
  assert.equal(result.safeToStop, false);
  assert.ok(result.blockers.some((item) => item.kind === 'missing_tables'));
});
