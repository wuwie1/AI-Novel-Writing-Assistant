const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { initializeTemporarySqliteDatabase } = require("./testInfrastructure/tempSqliteDatabase.cjs");

let prisma, lifecycle, root;
test.before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "comic-deletion-"));
  process.env.DATABASE_URL = initializeTemporarySqliteDatabase(root, "test.db");
  process.env.AI_NOVEL_RUNTIME = "desktop";
  process.env.AI_NOVEL_APP_DATA_DIR = root;
  process.env.AI_NOVEL_DATABASE_MODE = "sqlite";
  ({ prisma } = require("../dist/db/prisma"));
  lifecycle = require("../dist/services/comic/lifecycle");
});
test.after(async () => { await prisma?.$disconnect(); }); // Keep isolated fixtures and backups for inspection.

async function fixture() {
  const project = await prisma.comicProject.create({ data: {
    title: "待删除漫画", sourceType: "novel_import", sourceRef: "original-novel",
    sourceBundle: { create: { bundleJson: "{}" } },
    characters: { create: { name: "角色" } }, scenes: { create: { name: "场景" } },
    episodes: { create: { order: 1, panels: { create: { order: 1, action: "分格内容" } } } },
    facts: { create: { text: "剧情事实" } },
    exportJobs: { create: { format: "png", status: "done" } },
    batchJobs: { create: { type: "episode_image_batch", status: "completed" } },
  }, include: { characters: true, scenes: true, episodes: { include: { panels: true } }, exportJobs: true } });
  const asset = await prisma.comicCharacterAsset.create({ data: { projectId: project.id,
    characterId: project.characters[0].id, assetType: "costume", name: "服装" } });
  const relative = [
    `comic-characters/${project.characters[0].id}`, `comic-character-assets/${asset.id}`,
    `comic-scenes/${project.scenes[0].id}`, `comic-panels/${project.episodes[0].panels[0].id}`,
    `comic-panels-lettered/${project.episodes[0].panels[0].id}`, `comic-exports/${project.exportJobs[0].id}`,
  ];
  const files = relative.map(dir => path.join(root, "storage/generated-images", dir, "test.png"));
  for (const file of files) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "image-data"); }
  await prisma.comicUploadAsset.create({ data: { projectId: project.id, kind: "image", filePath: files[0] } });
  return { project, files, relative };
}

test("confirmed deletion cascades every owned row and file, keeps other projects and verified backup", async () => {
  const { project, files, relative } = await fixture();
  const other = await fixture();
  const source = await prisma.novel.create({ data: { id: "original-novel", title: "原小说" } });
  await lifecycle.deleteComicProjectWithBackup(project.id);
  assert.equal(await prisma.comicProject.findUnique({ where: { id: project.id } }), null);
  for (const model of ["comicSourceBundle", "comicCharacter", "comicCharacterAsset", "comicScene", "comicEpisode", "comicFact", "comicUploadAsset", "comicExportJob", "comicBatchJob"]) {
    assert.equal(await prisma[model].count({ where: { projectId: project.id } }), 0, model);
  }
  assert.equal(await prisma.comicPanel.count({ where: { episodeId: project.episodes[0].id } }), 0);
  for (const file of files) await assert.rejects(fs.stat(file), { code: "ENOENT" });
  assert.ok(await prisma.novel.findUnique({ where: { id: source.id } }));
  assert.ok(await prisma.comicProject.findUnique({ where: { id: other.project.id } }));
  for (const file of other.files) assert.equal(await fs.readFile(file, "utf8"), "image-data");
  const backupsRoot = path.join(root, "storage/comic-project-backups");
  const backup = path.join(backupsRoot, (await fs.readdir(backupsRoot))[0]);
  const saved = JSON.parse(await fs.readFile(path.join(backup, "project.json"), "utf8"));
  assert.equal(saved.id, project.id);
  assert.equal(saved.episodes[0].panels[0].action, "分格内容");
  assert.equal(saved.characterAssets.length, 1);
  for (const dir of relative) assert.equal(await fs.readFile(path.join(backup, "files", dir, "test.png"), "utf8"), "image-data");
  await lifecycle.deleteComicProjectWithBackup(project.id);
});

test("running batch and nested expression generation block deletion", async () => {
  const { project, files } = await fixture();
  const job = await prisma.comicBatchJob.create({ data: { projectId: project.id, type: "test", status: "running" } });
  await assert.rejects(lifecycle.deleteComicProjectWithBackup(project.id), { statusCode: 409 });
  await prisma.comicBatchJob.update({ where: { id: job.id }, data: { status: "completed" } });
  await prisma.comicCharacter.update({ where: { id: project.characters[0].id }, data: { sheetData: JSON.stringify({ status: "done", assets: { expression: { status: "generating" } } }) } });
  await assert.rejects(lifecycle.deleteComicProjectWithBackup(project.id), { statusCode: 409 });
  for (const file of files) assert.equal(await fs.readFile(file, "utf8"), "image-data");
});

test("failed backup and out-of-scope upload paths leave the project intact", async () => {
  const { project, files } = await fixture();
  const original = fs.cp;
  fs.cp = async () => { throw new Error("disk full"); };
  try { await assert.rejects(lifecycle.deleteComicProjectWithBackup(project.id), /disk full/); }
  finally { fs.cp = original; }
  await prisma.comicUploadAsset.create({ data: { projectId: project.id, kind: "image", filePath: "../../outside.png" } });
  await assert.rejects(lifecycle.deleteComicProjectWithBackup(project.id), { statusCode: 409 });
  assert.ok(await prisma.comicProject.findUnique({ where: { id: project.id } }));
  for (const file of files) assert.equal(await fs.readFile(file, "utf8"), "image-data");
});

test("database deletion failure restores files from the verified backup", async () => {
  const { project, files } = await fixture();
  const original = prisma.comicProject.delete;
  prisma.comicProject.delete = async () => { throw new Error("database unavailable"); };
  try { await assert.rejects(lifecycle.deleteComicProjectWithBackup(project.id), /database unavailable/); }
  finally { prisma.comicProject.delete = original; }
  assert.ok(await prisma.comicProject.findUnique({ where: { id: project.id } }));
  for (const file of files) assert.equal(await fs.readFile(file, "utf8"), "image-data");
});

test("mutation/deletion exclusion lasts until the operation settles and releases on failure", async () => {
  await lifecycle.withComicMutation(async () => {
    await assert.rejects(lifecycle.withComicDeletion(async () => {}), { statusCode: 409 });
  });
  await lifecycle.withComicDeletion(async () => {
    await assert.rejects(lifecycle.withComicMutation(async () => {}), { statusCode: 409 });
    await assert.rejects(lifecycle.withComicDeletion(async () => {}), { statusCode: 409 });
  });
  await assert.rejects(lifecycle.withComicDeletion(async () => { throw new Error("failed"); }), /failed/);
  await lifecycle.withComicMutation(async () => {});
});

test("partial file cleanup failure restores all files and retains database rows", async () => {
  const { project, files } = await fixture();
  const original = fs.rm;
  let calls = 0;
  fs.rm = async (...args) => { if (++calls === 2) throw new Error("permission denied"); return original(...args); };
  try { await assert.rejects(lifecycle.deleteComicProjectWithBackup(project.id), /permission denied/); }
  finally { fs.rm = original; }
  assert.ok(await prisma.comicProject.findUnique({ where: { id: project.id } }));
  for (const file of files) assert.equal(await fs.readFile(file, "utf8"), "image-data");
});

test("symbolic links cannot broaden the cleanup scope", async () => {
  const { project, files } = await fixture();
  const outside = path.join(root, "outside-image.png");
  await fs.writeFile(outside, "keep");
  await fs.symlink(outside, path.join(path.dirname(files[0]), "link.png"));
  await assert.rejects(lifecycle.deleteComicProjectWithBackup(project.id), /符号链接/);
  assert.equal(await fs.readFile(outside, "utf8"), "keep");
  assert.ok(await prisma.comicProject.findUnique({ where: { id: project.id } }));
});

test("HTTP delete uses cleanup and reports busy conflicts without deleting", async (t) => {
  const express = require("express");
  const { errorHandler } = require("../dist/middleware/errorHandler");
  const router = require("../dist/modules/comic/http/comicRoutes").default;
  const app = express();
  app.use(express.json());
  app.use("/api/comic", router);
  app.use(errorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { project, files } = await fixture();
  const url = `http://127.0.0.1:${server.address().port}/api/comic/projects/${project.id}`;
  await lifecycle.withComicMutation(async () => {
    const busy = await fetch(url, { method: "DELETE" });
    assert.equal(busy.status, 409);
    assert.equal((await busy.json()).success, false);
  });
  const response = await fetch(url, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  const repeated = await fetch(url, { method: "DELETE" });
  assert.equal(repeated.status, 200);
  for (const file of files) await assert.rejects(fs.stat(file), { code: "ENOENT" });
});
