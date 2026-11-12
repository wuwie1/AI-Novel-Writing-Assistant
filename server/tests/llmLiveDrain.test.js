const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const { LlmLiveBroker } = require("../dist/platform/llm/live/LlmLiveBroker");
const { createLlmLiveRouter } = require("../dist/platform/llm/live/http/llmLiveRoutes");
const { isObservationDraining } = require("../dist/platform/llm/live/http/observationDrain");

async function deadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("stream did not drain")), 3000); })]); }
  finally { clearTimeout(timer); }
}
async function snapshot(reader) {
  let text = "";
  while (!text.includes("\n\n")) {
    const { value, done } = await deadline(reader.read());
    assert.equal(done, false);
    text += new TextDecoder().decode(value);
  }
  return JSON.parse(text.split("\n").find(line => line.startsWith("data: ")).slice(6));
}

test("only a valid unexpired observation lease drains; a crashed deployment cannot disable live forever", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "observer-lease-"));
  const file = path.join(root, "control.json");
  assert.equal(await isObservationDraining(file, 100), false);
  for (const [value, expected] of [
    [{ version: 1, expiresAt: 101 }, true], [{ version: 1, expiresAt: 100 }, false],
    [{ version: 1, expiresAt: 99 }, false], [{ version: 2, expiresAt: 101 }, false],
    [{ version: 1, expiresAt: "101" }, false], [null, false],
  ]) {
    await fs.writeFile(file, JSON.stringify(value));
    assert.equal(await isObservationDraining(file, 100), expected);
  }
  await fs.writeFile(file, "broken");
  assert.equal(await isObservationDraining(file, 100), false);
});

test("maintenance closes existing observers, refuses reconnects, preserves generation, then resumes snapshots", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "observer-http-"));
  const file = path.join(root, "control.json");
  const broker = new LlmLiveBroker();
  let subscribers = 0;
  const subscribe = broker.subscribe.bind(broker);
  broker.subscribe = (...args) => {
    const unsubscribe = subscribe(...args);
    subscribers++;
    return () => { subscribers--; unsubscribe(); };
  };
  const session = broker.begin({ label: "正在写作", mode: "text" });
  session.delta("保存前的内容");
  const app = express();
  app.use("/live", createLlmLiveRouter({ broker, drainActive: () => isObservationDraining(file), drainPollMs: 10 }));
  let productionResponse, productionClosed = false;
  app.get("/generate", (_req, res) => {
    productionResponse = res;
    res.setHeader("Content-Type", "text/event-stream");
    res.write("data: generation\n\n");
    res.on("close", () => { productionClosed = true; });
  });
  const server = app.listen(0, "127.0.0.1");
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const production = await fetch(base + "/generate");
  const response = await fetch(base + "/live/stream");
  assert.equal(response.headers.get("connection"), "close");
  const reader = response.body.getReader();
  const initial = await snapshot(reader);
  assert.equal(initial.sessions[0].preview, "保存前的内容");
  assert.equal(subscribers, 1);
  await fs.writeFile(file, JSON.stringify({ version: 1, expiresAt: Date.now() + 90000 }));
  await deadline((async () => { while (!(await reader.read()).done) {} })());
  assert.equal(subscribers, 0);
  await deadline((async () => { while (sockets.size !== 1) await new Promise(resolve => setTimeout(resolve, 10)); })());
  const refused = await fetch(base + "/live/stream");
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("retry-after"), "2");
  await refused.json();
  assert.equal(subscribers, 0);
  assert.equal(productionClosed, false);
  session.delta("，继续写作");
  assert.equal(broker.getSnapshots({})[0].completedAt, null);
  // Expiry is also the recovery path if the deployment process is lost.
  await fs.writeFile(file, JSON.stringify({ version: 1, expiresAt: Date.now() - 1 }));
  const controller = new AbortController();
  const resumed = await fetch(base + "/live/stream", { signal: controller.signal });
  assert.equal(resumed.status, 200);
  assert.equal((await snapshot(resumed.body.getReader())).sessions[0].preview, "保存前的内容，继续写作");
  controller.abort();
  await deadline((async () => { while (subscribers) await new Promise(resolve => setTimeout(resolve, 10)); })());
  assert.equal(productionClosed, false);
  session.complete();
  productionResponse.end();
  await production.text();
});
