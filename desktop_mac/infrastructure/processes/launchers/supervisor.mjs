import { spawn, spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { appendLogChunk } from '../logging.mjs';

const [role, logFile, errorFile, executable, ...args] = process.argv.slice(2);
if (!executable || !logFile || !errorFile) throw new Error('Missing supervised command or log files');
let stopping = false;
let child;
let wake;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  stopping = true;
  wake?.();
  if (child?.exitCode === null) child.kill(signal);
});
const sink = (file) => new Writable({ write(chunk, _encoding, done) { appendLogChunk(file, chunk).then(() => done(), done); } });
let backoff = 1_000;
do {
  const started = Date.now();
  child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const streams = [pipeline(child.stdout, sink(logFile)), pipeline(child.stderr, sink(errorFile))];
  const code = await new Promise((resolve) => {
    child.once('error', (error) => { void appendLogChunk(errorFile, Buffer.from(`${error.message}\n`)); resolve(1); });
    child.once('exit', (value) => resolve(value ?? 1));
  });
  await Promise.allSettled(streams);
  if (role !== 'tunnel' || stopping) { process.exitCode = stopping ? 0 : code; break; }
  // Reconnect the transport only; never replay an API request or task operation.
  if (Date.now() - started > 60_000) backoff = 1_000;
  await appendLogChunk(errorFile, Buffer.from(`SSH disconnected; reconnecting in ${backoff / 1000}s\n`));
  await new Promise((resolve) => { const timer = setTimeout(resolve, backoff); wake = () => { clearTimeout(timer); resolve(); }; });
  wake = undefined;
  backoff = Math.min(backoff * 2, 30_000);
} while (!stopping);

// One-shot jobs must not leave a loaded but exited label blocking the next start.
const label = process.env.MAC_LAUNCHD_LABEL;
if (label && !stopping) {
  const job = spawnSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' });
  if (Number(job.stdout?.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1]) === process.pid) spawnSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
}
