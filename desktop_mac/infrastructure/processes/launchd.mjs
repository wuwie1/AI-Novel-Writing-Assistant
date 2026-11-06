import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stableHash } from './identity.mjs';
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
