const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("desktop release notes are sourced from the full history and current package version has a dated entry", () => {
  const desktop = JSON.parse(read("desktop/package.json"));
  const notes = read("docs/releases/release-notes.md");
  const appNotes = read("client/src/components/layout/desktopReleaseNotes.ts");
  assert.match(desktop.version, /^\d+\.\d+\.\d+$/);
  const dates = [...notes.matchAll(/^### (\d{4}-\d{2}-\d{2})$/gm)].map(match => match[1]);
  assert.ok(dates.length > 0);
  assert.equal(new Set(dates).size, dates.length, "same-day updates must share one date block");
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.match(notes, new RegExp(`桌面版本 .?v${desktop.version.replaceAll(".", "\\.")}`),
    `release-notes.md must preserve upstream desktop ${desktop.version} context`);
  assert.match(appNotes, /release-notes\.md\?raw/, "in-app notes must read the canonical release history");
  // Failed packaging tag must remain documented as a dated entry without claiming installers shipped.
  assert.match(notes, /^### 2026-11-14$/m);
  assert.match(notes, /v0\.8\.3[\s\S]*?没有[\s\S]*?安装包/);
  const latest = read("README.md").split("## 最新更新")[1].split(/\n## /)[0];
  assert.deepEqual([...latest.matchAll(/^### (\d{4}-\d{2}-\d{2})$/gm)].map(match => match[1]), [dates[0]]);
  assert.match(latest, /docs\/releases\/release-notes\.md/);
  const typescript = require("typescript");
  const vm = require("node:vm");
  const exports = {};
  vm.runInNewContext(typescript.transpileModule(appNotes, {compilerOptions: {module: typescript.ModuleKind.CommonJS}}).outputText, {
    exports, require: id => id === "@/lib/constants" ? {APP_VERSION: desktop.version} : {default: notes},
  });
  const shown = exports.CURRENT_DESKTOP_RELEASE_NOTES;
  assert.equal(shown.version, desktop.version);
  assert.ok(shown.items.length > 0, "date-based history must populate the in-app update dialog");
  assert.ok(shown.summary.includes(desktop.version));
});
