import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stableHash } from './identity.mjs';
import { inspectProcess } from './identity.mjs';
import { readProcessArgv } from './argv.mjs';
const run = promisify(execFile);

export function launchdLabel({ repoRealPath, mode, role }) { return `app.ai-novel.desktop-mac.${stableHash(repoRealPath)}.${mode}.${role}`; }

export function createLaunchdPlist({ label, executable, args, repoRealPath, logPath, errorPath, pathValue, environment = {} }) {
  const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const array = (values) => values.map((value) => `<string>${String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`).join('');
  const values = { PATH: pathValue, ...environment };
  const env = Object.entries(values).map(([key, value]) => `<key>${key}</key><string>${String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${array([executable, ...args])}</array><key>WorkingDirectory</key><string>${xml(repoRealPath)}</string><key>EnvironmentVariables</key><dict>${env}</dict><key>StandardOutPath</key><string>${xml(logPath)}</string><key>StandardErrorPath</key><string>${xml(errorPath)}</string><key>RunAtLoad</key><true/></dict></plist>\n`;
}

export async function launchAgent(plistPath, { exec = run } = {}) { return exec('/bin/launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath]); }
export async function stopAgent(label, { exec = run } = {}) { return exec('/bin/launchctl', ['bootout', `gui/${process.getuid()}/${label}`]); }
export async function printAgent(label, { exec = run } = {}) { return exec('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`]); }

/** launchctl can expose a PID before xpcproxy has exec'd the requested process. */
export async function waitForAgentIdentity(label, expectedArgv, {
  print = printAgent, inspect = inspectProcess, readArgv = readProcessArgv,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), timeoutMs = 5000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await print(label);
      const pid = Number(stdout.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1]);
      if (pid) {
        const argv = await readArgv(pid);
        if (JSON.stringify(argv) === JSON.stringify(expectedArgv)) {
          const identity = await inspect(pid);
          if (identity && !identity.command.startsWith('xpcproxy ')) return identity;
        }
      }
    } catch { /* launchd has not published a stable process yet. */ }
    await wait(100);
  }
  throw Object.assign(new Error(`launchd job ${label} did not execute its verified command`), { exitCode: 5 });
}
