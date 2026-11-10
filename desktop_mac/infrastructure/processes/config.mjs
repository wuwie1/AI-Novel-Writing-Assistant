import path from 'node:path';
import { realpath, readFile, stat } from 'node:fs/promises';

const DEFAULTS = Object.freeze({
  localApiPort: 3000,
  devUiPort: 15174,
  appUiPort: 15175,
  tunnelPort: 15173,
  sshTarget: 'root@152.136.155.200',
  remoteWebPort: 18080,
  maintenanceProbePort: 18081,
  serverDir: '/data/write/AI-Novel-Writing-Assistant',
  deployRef: 'origin/ai',
});

const ENV_FIELDS = Object.freeze({
  localApiPort: 'LOCAL_API_PORT', devUiPort: 'DEV_UI_PORT', appUiPort: 'APP_UI_PORT',
  tunnelPort: 'TUNNEL_PORT', sshTarget: 'SSH_TARGET', remoteWebPort: 'REMOTE_WEB_PORT',
  maintenanceProbePort: 'MAINTENANCE_PROBE_PORT', serverDir: 'SERVER_DIR', deployRef: 'DEPLOY_REF',
});

function bad(message) { const error = new Error(message); error.exitCode = 2; throw error; }

function validate(config, repoRealPath) {
  for (const key of Object.keys(ENV_FIELDS)) {
    const value = config[key];
    if (key.toLowerCase().endsWith('port')) {
      if (!Number.isInteger(value) || value < 1 || value > 65535) bad(`${ENV_FIELDS[key]} must be an integer port from 1 to 65535`);
    } else if (typeof value !== 'string' || !value.trim()) bad(`${ENV_FIELDS[key]} must be a non-empty string`);
  }
  const portKeys = ['localApiPort', 'devUiPort', 'appUiPort', 'tunnelPort', 'remoteWebPort', 'maintenanceProbePort'];
  const ports = portKeys.map((key) => config[key]);
  if (new Set(ports).size !== ports.length) bad('Mac API, UI, tunnel, remote web and maintenance ports must be distinct');
  if (!/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+$/.test(config.sshTarget)) bad('SSH_TARGET must be a user@host or host value without SSH options');
  if (!path.isAbsolute(config.serverDir) || path.resolve(config.serverDir) === path.parse(config.serverDir).root) bad('SERVER_DIR must be an absolute non-root path');
  if (config.deployRef.startsWith('-') || /[\0\r\n]/.test(config.deployRef)) bad('DEPLOY_REF is invalid');
  return Object.freeze({ ...config, repoRealPath });
}

/** Load non-secret Mac settings. Environment/Make values override the JSON file. */
export async function loadConfig({ repoRoot = process.cwd(), env = process.env, configPath, fallbackSshTarget = DEFAULTS.sshTarget } = {}) {
  let repoRealPath;
  try { repoRealPath = await realpath(repoRoot); } catch { bad(`Repository path does not exist: ${repoRoot}`); }
  const filePath = configPath ?? path.join(repoRealPath, '.runtime/desktop_mac/config.json');
  let fileConfig = {};
  try {
    const raw = await readFile(filePath, 'utf8');
    const info = await stat(filePath);
    if ((info.mode & 0o077) !== 0) bad(`Mac config must be private (0600): ${filePath}`);
    fileConfig = JSON.parse(raw);
    if (!fileConfig || Array.isArray(fileConfig) || typeof fileConfig !== 'object') bad('Mac config JSON must be an object');
    const unknownKeys = Object.keys(fileConfig).filter((key) => !Object.hasOwn(DEFAULTS, key));
    if (unknownKeys.length) bad(`Mac config contains unsupported fields: ${unknownKeys.join(', ')}`);
  } catch (error) {
    if (error.code !== 'ENOENT') bad(`Cannot read Mac config ${filePath}: ${error.message}`);
  }
  const config = { ...DEFAULTS, sshTarget: fallbackSshTarget, ...fileConfig };
  for (const [key, name] of Object.entries(ENV_FIELDS)) {
    if (env[name] === undefined || env[name] === '') continue;
    config[key] = key.toLowerCase().endsWith('port') ? Number(env[name]) : env[name];
  }
  return validate(config, repoRealPath);
}

export function getRepoPaths(repoRealPath) {
  const root = path.resolve(repoRealPath);
  const runtime = path.join(root, '.runtime/desktop_mac');
  return Object.freeze({
    repoRoot: root,
    runtimeDir: runtime,
    configFile: path.join(runtime, 'config.json'),
    stateFile: path.join(runtime, 'state.json'),
    lifecycleLock: path.join(runtime, 'lifecycle.lock'),
    logDir: path.join(root, '.logs/desktop_mac'),
    buildsDir: path.join(runtime, 'builds'),
    defaultRendererDir: path.join(root, 'desktop_mac/dist/renderer'),
  });
}

export { DEFAULTS as defaultConfigValues };
