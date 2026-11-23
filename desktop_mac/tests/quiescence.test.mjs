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

test('a verified pre-discussion database can drain, but a missing migrated table blocks shutdown', async t => {
  const {dbPath} = await fixture(t);
  const prepare = spawnSync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    for name in ('AgentConversationTurn', 'OpeningCandidateProposal', 'DirectorFinalApproval'):
        db.execute('ALTER TABLE '+name+' RENAME TO fixture_'+name+'_unused')
    db.execute('CREATE TABLE _prisma_migrations (migration_name TEXT, finished_at TEXT, rolled_back_at TEXT)')
    db.execute("INSERT INTO _prisma_migrations VALUES ('20261116135000_invocation_output_budget','done',NULL)")`, dbPath]);
  assert.equal(prepare.status, 0);
  assert.equal((await inspectSqliteQuiescence({dbPath})).safeToStop, true);
  const migrated = spawnSync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("INSERT INTO _prisma_migrations VALUES ('20261121150000_agent_conversation_turn','done',NULL)")`, dbPath]);
  assert.equal(migrated.status, 0);
  assert.equal((await inspectSqliteQuiescence({dbPath})).safeToStop, false);
});

test('discussion turns block shutdown until their active slot is released and their status is final', async t => {
  const { dbPath } = await fixture(t);
  for (const [status, slot, safe] of [
    ['running', 'running', false], ['running', '', false], ['completed', 'running', false],
    ['pending', '', false], ['completed', '', true], ['interrupted', '', true], ['failed', '', true],
  ]) {
    const seed = spawnSync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("INSERT OR REPLACE INTO AgentConversationTurn(rowid,status,activeSlot) VALUES (1,?,?)", (sys.argv[2],sys.argv[3] or None))`, dbPath, status, slot]);
    assert.equal(seed.status, 0);
    const result = await inspectSqliteQuiescence({dbPath});
    assert.equal(result.safeToStop, safe, JSON.stringify(result));
  }
});

test('outline feedback blocks shutdown while dispatchable or running and preserves manual retry', async t => {
  const { dbPath } = await fixture(t);
  for (const [status, blocker] of [
    ['pending', 'active_task'], ['running', 'active_task'], ['paused', 'unknown_status'],
    ['completed', null], ['failed', null],
  ]) {
    const seed = spawnSync('python3', ['-c', `import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as db:
    db.execute("INSERT OR REPLACE INTO OutlineFeedbackRun(rowid,status,attempt) VALUES (1,?,1)", (sys.argv[2],))`, dbPath, status]);
    assert.equal(seed.status, 0);
    const result = await inspectSqliteQuiescence({dbPath});
    assert.equal(result.safeToStop, !blocker, JSON.stringify(result));
    if (blocker) assert.ok(result.blockers.some(item => item.table === 'OutlineFeedbackRun' && item.kind === blocker));
  }
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

test('queued chapter jobs awaiting explicit recovery are quiescent without clearing the pause', async (t) => {
  const {dbPath} = await fixture(t);
  const seeded = spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO GenerationJob(status,pendingManualRecovery,retryCount,maxRetries) VALUES ('queued',1,0,2)"); c.execute("INSERT INTO DirectorNextRunControl(status) VALUES ('paused')"); c.commit(); c.close()`, dbPath]);
  assert.equal(seeded.status, 0);
  const before = await readFile(dbPath);
  const result = await inspectSqliteQuiescence({dbPath});
  assert.equal(result.safeToStop, true, JSON.stringify(result));
  assert.deepEqual(await readFile(dbPath), before);
});

test('chapter manual recovery does not exempt runnable jobs or active and uncertain leases', async (t) => {
  for (const [status, manual, owner, expiry, kind] of [
    ['queued', 0, null, null, 'active_task'],
    ['running', 1, null, null, 'active_task'],
    ['queued', 1, 'worker', '4102444800000', 'active_lease'],
    ['queued', 1, 'worker', null, 'unbounded_lease'],
    ['queued', 1, null, 'invalid', 'invalid_lease_expiry'],
  ]) {
    const {dbPath} = await fixture(t);
    const seeded = spawnSync('python3', ['-c', `import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.execute('INSERT INTO GenerationJob(status,pendingManualRecovery,executionOwner,executionLeaseExpiresAt) VALUES (?,?,?,?)',json.loads(sys.argv[2])); c.commit(); c.close()`, dbPath, JSON.stringify([status, manual, owner, expiry])]);
    assert.equal(seeded.status, 0);
    const result = await inspectSqliteQuiescence({dbPath});
    assert.equal(result.safeToStop, false);
    assert.ok(result.blockers.some(item => item.table === 'GenerationJob' && item.kind === kind), JSON.stringify(result));
  }
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

test('dead side-effect jobs are quiescent and retain their failure record', async (t) => {
  const { dbPath } = await fixture(t);
  const seeded = spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("INSERT INTO NovelSideEffectJob(status,attempts,maxAttempts,lastError) VALUES ('dead',5,5,'preserve failure')"); c.commit(); c.close()`, dbPath]);
  assert.equal(seeded.status, 0);
  const before = await readFile(dbPath);
  const result = await inspectSqliteQuiescence({ dbPath });
  assert.equal(result.safeToStop, true, JSON.stringify(result));
  assert.deepEqual(await readFile(dbPath), before);
});

test('side-effect retries, active leases and misplaced dead statuses still block shutdown', async (t) => {
  for (const [table, status, expiry, kind] of [
    ['NovelSideEffectJob', 'failed', null, 'automatic_retry_candidate'],
    ['NovelSideEffectJob', 'pending', null, 'active_task'],
    ['NovelSideEffectJob', 'dead', '4102444800000', 'active_lease'],
    ['NovelSideEffectJob', 'future_status', null, 'unknown_status'],
    ['AgentRun', 'dead', null, 'unknown_status'],
  ]) {
    const { dbPath } = await fixture(t);
    const seeded = spawnSync('python3', ['-c', `import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); table=sys.argv[2]; c.execute('INSERT INTO '+table+'(status) VALUES (?)',(sys.argv[3],));
if table=='NovelSideEffectJob': c.execute('UPDATE NovelSideEffectJob SET attempts=1,maxAttempts=5,leaseOwner=?,leaseExpiresAt=?',('worker' if sys.argv[4] else None,sys.argv[4] or None))
c.commit(); c.close()`, dbPath, table, status, expiry ?? '']);
    assert.equal(seeded.status, 0, seeded.stderr?.toString());
    const result = await inspectSqliteQuiescence({ dbPath });
    assert.equal(result.safeToStop, false, `${table}:${status}`);
    assert.ok(result.blockers.some(item => item.table === table && item.kind === kind), JSON.stringify(result));
  }
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
