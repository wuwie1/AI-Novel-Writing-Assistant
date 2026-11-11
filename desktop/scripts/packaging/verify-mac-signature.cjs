const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);

async function verifyMacSignature(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  } catch (error) {
    throw new Error(`Mac app signature verification failed: ${appPath}\n${error.stderr || error.message}`, { cause: error });
  }
  console.log(`[desktop-sign] verified Mac bundle and nested code: ${appPath}`);
}

module.exports = verifyMacSignature;
