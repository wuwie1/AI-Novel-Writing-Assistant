import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Persistent worker and retry tables that must be inspected before stopping a local API.
 * Column lists are intentional: a schema drift that adds/removes lease or retry fields fails closed.
 */
export const QUIESCENCE_TABLE_SCHEMA = Object.freeze({
  NovelWorkflowTask: ['status', 'pendingManualRecovery', 'attemptCount', 'maxAttempts', 'heartbeatAt'],
  GenerationJob: ['status', 'pendingManualRecovery', 'retryCount', 'maxRetries', 'executionOwner', 'executionLeaseExpiresAt', 'heartbeatAt'],
  ImageGenerationTask: ['status', 'pendingManualRecovery', 'retryCount', 'maxRetries', 'heartbeatAt'],
  StyleExtractionTask: ['status', 'pendingManualRecovery', 'retryCount', 'maxRetries', 'heartbeatAt'],
  AgentRun: ['status'],
  CreativeHubThread: ['status'],
  AgentApproval: ['status', 'expiresAt'],
  DirectorRunCommand: ['status', 'leaseOwner', 'leaseExpiresAt', 'runAfter', 'attempt'],
  DirectorRuntimeInstance: ['status', 'lastHeartbeatAt'],
  DirectorRuntimeCommand: ['status', 'leaseOwner', 'leaseExpiresAt', 'runAfter', 'attempt'],
  DirectorRuntimeExecution: ['status', 'leaseExpiresAt', 'heartbeatAt'],
  DirectorStepRun: ['status', 'finishedAt'],
  DirectorNextRunControl: ['status', 'leaseOwner', 'leaseExpiresAt', 'heartbeatAt'],
  ProductionUnitRun: ['activeStage', 'activeRequestKey'],
  ShortStoryRevisionJob: ['status', 'leaseToken', 'leaseExpiresAt'],
  CreationStudioConfirmation: ['status'],
  StructuredInvocationDiagnostic: ['status', 'attempt'],
  BookAnalysis: ['status', 'pendingManualRecovery', 'attemptCount', 'maxAttempts', 'heartbeatAt'],
  BookAnalysisSection: ['status'],
  KnowledgeDocument: ['status', 'latestIndexStatus'],
  RagIndexJob: ['status', 'attempts', 'maxAttempts', 'runAfter'],
  NovelSideEffectJob: ['status', 'attempts', 'maxAttempts', 'runAfter', 'leaseOwner', 'leaseExpiresAt'],
  ComicExportJob: ['status'],
  DramaBatchJob: ['status'],
  ComicBatchJob: ['status'],
  MarketScanRun: ['status'],
  ChapterArtifactSyncCheckpoint: ['status'],
});

const KNOWN_NON_QUEUE_TABLES = new Set([
  'ChapterAutomaticAttempt', 'DirectorRun', 'DirectorRuntimeCheckpoint', 'DirectorRuntimeEvent',
  'DirectorNextRun', 'DirectorNextCommand', 'ReplanRun', 'TaskCenterArchive', 'CreativeHubCheckpoint',
]);

const SQLITE_INSPECTOR = String.raw`
import json, sqlite3, sys, urllib.parse, datetime, re
payload=json.load(sys.stdin)
db=payload['dbPath']
required=payload['schema']
known_non_queue=set(payload['knownNonQueue'])
active={'queued','running','processing','retrying','leased','waiting_worker','waiting_llm_resource','waiting_retry','failed_recoverable','claimed','in_progress','sending','building','generating','reconciling'}
manual={'waiting_approval','waiting_gate','paused','pending_manual_recovery','needs_approval','awaiting_user','waiting_review','blocked','interrupted','cancelled_by_user','failed_hard','stale','pending'}
pending_queues={'NovelSideEffectJob','ComicExportJob','DramaBatchJob','ComicBatchJob'}
terminal={'succeeded','success','completed','complete','done','failed','cancelled','canceled','rejected','expired','archived','published','skipped','confirmed','failed_hard','delivered','sent','idle','ready'}
# A completed creation handoff leaves the successor workflow/director responsible for active work.
table_terminal={'CreationStudioConfirmation': {'handed_off'}}
status_known=active|manual|terminal|{'draft','attached','not_started','open','closed','enabled','disabled'}
now=datetime.datetime.now(datetime.timezone.utc)
def parse_time(value):
    if value is None: return None
    if isinstance(value,(int,float)): return datetime.datetime.fromtimestamp(value/1000 if abs(value)>100000000000 else value,datetime.timezone.utc)
    raw=str(value).strip()
    if not raw: return None
    if re.fullmatch(r'-?\d+(?:\.\d+)?',raw):
        numeric=float(raw)
        return datetime.datetime.fromtimestamp(numeric/1000 if abs(numeric)>100000000000 else numeric,datetime.timezone.utc)
    try:
        parsed=datetime.datetime.fromisoformat(raw.replace('Z','+00:00'))
        if parsed.tzinfo is None: parsed=parsed.replace(tzinfo=datetime.timezone.utc)
        return parsed.astimezone(datetime.timezone.utc)
    except Exception: return 'invalid'
def reject(reason, blockers=None, checked=None):
    print(json.dumps({'safeToStop':False,'reason':reason,'blockers':blockers or [],'checkedTables':checked or []}))
def main():
    uri='file:'+urllib.parse.quote(db,safe='/')+'?mode=ro'
    conn=sqlite3.connect(uri,uri=True,timeout=2.0)
    conn.row_factory=sqlite3.Row
    conn.execute('PRAGMA query_only=ON')
    conn.execute('PRAGMA busy_timeout=2000')
    tables={row['name'] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
    missing=sorted(set(required)-tables)
    if missing:
        reject('database schema does not contain all covered task tables', [{'kind':'missing_tables','count':len(missing),'tables':missing}]); return
    candidate_pattern=re.compile(r'(Task|Job|Run|Command|Execution|Queue|Worker|Confirmation|Diagnostic|Checkpoint|Approval|Request|Attempt|Pipeline|Retry|Lease)$',re.I)
    covered=set(required)|known_non_queue
    unknown=sorted(name for name in tables if candidate_pattern.search(name) and name not in covered)
    if unknown:
        reject('unclassified persistent task tables are present', [{'kind':'unknown_tables','count':len(unknown),'tables':unknown}]); return
    blockers=[]; checked=[]
    for table,expected in required.items():
        cols={row['name'] for row in conn.execute('PRAGMA table_info("'+table.replace('"','""')+'")')}
        missing_cols=sorted(set(expected)-cols)
        relevant={c for c in cols if re.search(r'(?:^status$|lease|retry|attempt|heartbeat|pendingManualRecovery|activeRequestKey|activeStage|runAfter|latestIndexStatus)',c,re.I)}
        unexpected=sorted(relevant-set(expected))
        if missing_cols or unexpected:
            blockers.append({'kind':'schema_drift','table':table,'missingColumns':missing_cols,'unclassifiedColumns':unexpected}); continue
        checked.append(table)
        quoted='"'+table.replace('"','""')+'"'
        cursor=conn.execute('SELECT * FROM '+quoted)
        for row in cursor:
            values=dict(row)
            if table=='ProductionUnitRun':
                stage=values.get('activeStage'); key=values.get('activeRequestKey')
                if bool(stage)!=bool(key): blockers.append({'kind':'invalid_active_request','table':table,'count':1})
                elif key: blockers.append({'kind':'active_production_request','table':table,'count':1})
                continue
            for status_key in ('status','latestIndexStatus'):
                if status_key not in values: continue
                status=values[status_key]
                if not isinstance(status,str) or (status not in status_known and status not in table_terminal.get(table,set())):
                    blockers.append({'kind':'unknown_status','table':table,'count':1}); break
                if status in active or status=='pending' and table in pending_queues:
                    if table=='NovelWorkflowTask' and values.get('pendingManualRecovery') in (1,True) and status=='waiting_approval': continue
                    blockers.append({'kind':'active_task','table':table,'status':status,'count':1}); break
                if status in manual and table=='CreationStudioConfirmation' and status=='claimed':
                    blockers.append({'kind':'active_confirmation','table':table,'status':status,'count':1}); break
                if status=='failed':
                    pending_manual=values.get('pendingManualRecovery') in (1,True)
                    attempt=values.get('retryCount',values.get('attemptCount',values.get('attempts')))
                    maximum=values.get('maxRetries',values.get('maxAttempts'))
                    if not pending_manual and isinstance(attempt,int) and isinstance(maximum,int) and attempt<maximum:
                        blockers.append({'kind':'automatic_retry_candidate','table':table,'count':1}); break
            else:
                pass
            if blockers and blockers[-1].get('table')==table and blockers[-1].get('kind') in ('unknown_status','active_task','active_confirmation','automatic_retry_candidate'):
                continue
            lease_pairs=[('leaseOwner','leaseExpiresAt'),('leaseToken','leaseExpiresAt'),('executionOwner','executionLeaseExpiresAt')]
            for owner_key,expiry_key in lease_pairs:
                if expiry_key not in values: continue
                owner=values.get(owner_key); expiry=values.get(expiry_key)
                parsed=parse_time(expiry)
                if parsed=='invalid': blockers.append({'kind':'invalid_lease_expiry','table':table,'count':1}); break
                if parsed is not None and parsed>now:
                    blockers.append({'kind':'active_lease','table':table,'count':1}); break
                if owner and parsed is None and values.get('status') not in terminal and values.get('status') not in manual:
                    blockers.append({'kind':'unbounded_lease','table':table,'count':1}); break
            if table=='DirectorNextRunControl' and values.get('status') in ('queued','running','waiting_gate'):
                if values.get('status') in ('queued','running') and not any(b.get('table')==table and b.get('kind')=='active_task' for b in blockers):
                    blockers.append({'kind':'active_director_control','table':table,'status':values.get('status'),'count':1})
            if table=='DirectorRuntimeExecution' and values.get('status')=='leased':
                parsed=parse_time(values.get('leaseExpiresAt'))
                if parsed is None or parsed=='invalid' or parsed>now:
                    if not any(b.get('table')==table and b.get('kind') in ('active_task','active_lease','invalid_lease_expiry') for b in blockers): blockers.append({'kind':'uncertain_runtime_execution','table':table,'count':1})
    if blockers:
        reject('persistent work is active, retryable, or cannot be classified',blockers,checked); return
    print(json.dumps({'safeToStop':True,'reason':'all covered task tables are quiescent','blockers':[],'checkedTables':checked}))
try: main()
except Exception as error:
    reject('read-only SQLite inspection failed: '+str(error))
`;

function unsafe(reason) { return { safeToStop: false, reason, blockers: [], checkedTables: [] }; }

export async function resolveLocalDatabasePath({ repoRoot, dbPath } = {}) {
  let root;
  try { root = await realpath(repoRoot ?? process.cwd()); } catch { throw new Error('Repository path cannot be verified'); }
  let selected = dbPath;
  if (!selected) {
    let envText;
    try { envText = await readFile(path.join(root, 'server/.env'), 'utf8'); } catch { throw new Error('server/.env is unavailable'); }
    const line = envText.split(/\r?\n/).find((item) => /^\s*DATABASE_URL\s*=/.test(item));
    const raw = line?.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!raw) throw new Error('DATABASE_URL is not configured');
    if (!raw.startsWith('file:')) throw new Error('Local backend database is not SQLite');
    let decoded;
    try { decoded = decodeURIComponent(raw.slice(5).split('?')[0] || './dev.db'); } catch { throw new Error('SQLite database URL is invalid'); }
    selected = path.resolve(root, 'server', decoded);
  }
  if (!path.isAbsolute(selected)) selected = path.resolve(root, selected);
  let resolved;
  try { resolved = await realpath(selected); } catch { throw new Error('SQLite database file does not exist'); }
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Local SQLite database must be inside this repository');
  return resolved;
}

export async function inspectSqliteQuiescence({ dbPath }) {
  if (typeof dbPath !== 'string' || !path.isAbsolute(dbPath)) return unsafe('SQLite database path must be absolute');
  let resolved;
  try { resolved = await realpath(dbPath); } catch { return unsafe('SQLite database file does not exist'); }
  try { if (!(await stat(resolved)).isFile()) return unsafe('SQLite database path is not a regular file'); }
  catch { return unsafe('SQLite database file cannot be inspected'); }
  const result = spawnSync('python3', ['-c', SQLITE_INSPECTOR], {
    input: JSON.stringify({ dbPath: resolved, schema: QUIESCENCE_TABLE_SCHEMA, knownNonQueue: [...KNOWN_NON_QUEUE_TABLES] }),
    encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return unsafe(`Read-only SQLite adapter failed${result.error?.code ? ` (${result.error.code})` : ''}`);
  try { return JSON.parse(result.stdout); } catch { return unsafe('SQLite adapter returned an invalid result'); }
}

export async function inspectLocalQuiescence({ repoRoot, dbPath } = {}) {
  try { return await inspectSqliteQuiescence({ dbPath: await resolveLocalDatabasePath({ repoRoot, dbPath }) }); }
  catch (error) { return unsafe(`${error.message}; local task state cannot be verified`); }
}
