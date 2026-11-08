#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nativeDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(nativeDir, '../..');
const args = process.argv.slice(2);
let outDir = resolve(repoRoot, '.runtime/desktop_mac/builds/native');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out-dir' && args[i + 1]) {
    const requested = args[++i];
    if (!requested.startsWith('/')) throw new Error('--out-dir must be an absolute path');
    outDir = resolve(requested);
  }
  else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
}
const appPath = join(outDir, 'AI Novel Mac.app');
const contents = join(appPath, 'Contents');
const executableDir = join(contents, 'MacOS');
const resources = join(contents, 'Resources');
const iconName = 'AppIcon.icns';
mkdirSync(executableDir, { recursive: true });
mkdirSync(resources, { recursive: true });
const icon = readFileSync(join(nativeDir, 'Resources', iconName));
writeFileSync(join(resources, iconName), icon);
const moduleCache = join(repoRoot, '.runtime/desktop_mac/swift-module-cache');
mkdirSync(moduleCache, { recursive: true });
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (path.endsWith('.swift')) files.push(path);
  }
}
walk(join(nativeDir, 'Sources'));
if (!files.length) throw new Error('No Swift sources found under native/Sources');
const version = JSON.parse(readFileSync(join(repoRoot, 'desktop/package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid desktop version: ${version}`);
const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>AI Novel Mac</string>
<key>CFBundleDisplayName</key><string>AI Novel</string>
<key>CFBundleIdentifier</key><string>app.ai-novel.desktop-mac</string>
<key>CFBundleExecutable</key><string>AI-Novel-Mac</string>
<key>CFBundleIconFile</key><string>${iconName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>`;
writeFileSync(join(contents, 'Info.plist'), info);
const swiftc = spawnSync('xcrun', ['swiftc', '-parse-as-library', '-module-cache-path', moduleCache, '-target', 'arm64-apple-macosx14.0', '-framework', 'AppKit', '-framework', 'WebKit', '-framework', 'Network', '-o', join(executableDir, 'AI-Novel-Mac'), ...files], { cwd: repoRoot, stdio: 'inherit' });
if (swiftc.status !== 0) throw new Error(`swiftc failed (${swiftc.status ?? swiftc.signal})`);
const hash = createHash('sha256');
for (const file of files) hash.update(readFileSync(file));
hash.update(info);
hash.update(icon);
writeFileSync(join(appPath, 'Contents', 'native-build.sha256'), hash.digest('hex') + '\n');
const sign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { cwd: repoRoot, stdio: 'inherit' });
if (sign.status !== 0) throw new Error(`ad-hoc codesign failed (${sign.status ?? sign.signal})`);
process.stdout.write(`${appPath}\n`);
