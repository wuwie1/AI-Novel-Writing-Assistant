const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {modelModality, modelPurposeError, defaultTextModel, usesLocalProxy} = require("@ai-novel/shared/utils/modelConnection/index");
const {createApp} = require("../dist/app");
const {prisma} = require("../dist/db/prisma");
const {resolveImageModel} = require("../dist/services/image/provider");

test("purpose validation separates image generation, vision, non-chat models, and unknown aliases", () => {
  for (const id of ["gpt-image-2", "openai/gpt-image-2", "dall-e-3", "black-forest-labs/FLUX.1-schnell"]) {
    assert.equal(modelModality(id), "image");
    assert.match(modelPurposeError(id, "text"), /不支持文本对话/);
    assert.equal(modelPurposeError(id, "image"), null);
  }
  for (const id of ["gpt-5", "gpt-4o", "claude-sonnet-4-5", "deepseek-flash"]) {
    assert.equal(modelModality(id), "text");
    assert.match(modelPurposeError(id, "image"), /不支持图像生成/);
  }
  for (const id of ["text-embedding-3-small", "tts-1", "omni-moderation-latest", "gpt-4o-mini-transcribe"]) {
    assert.ok(modelPurposeError(id, "text"));
    assert.ok(modelPurposeError(id, "image"));
  }
  assert.equal(modelModality("my-private-alias"), "unknown");
  assert.equal(modelPurposeError("my-private-alias", "image"), null);
  assert.equal(defaultTextModel(["gpt-image-2", "tts-1", "my-alias", "gpt-5"]), "gpt-5");
  assert.equal(defaultTextModel(["gpt-image-2", "tts-1"]), undefined);
  assert.equal(usesLocalProxy("http://127.0.0.1:14000/v1/"), true);
  assert.equal(usesLocalProxy("https://another.example/v1"), false);
});

test("provider save rejects incompatible roles before persistence, including manual input", async (t) => {
  let writes = 0;
  for (const [target, method] of [[prisma.aPIKey, "create"], [prisma.aPIKey, "upsert"], [prisma.appSetting, "upsert"]]) {
    const original = target[method];
    target[method] = async () => { writes++; };
    t.after(() => { target[method] = original; });
  }
  const server = http.createServer(createApp());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [method, path] of [["POST", "/api/settings/custom-providers"], ["PUT", "/api/settings/api-keys/openai"]]) {
    for (const input of [{model:"gpt-image-2", imageModel:""}, {model:"gpt-5", imageModel:"gpt-4o"}]) {
      const response = await fetch(base + path, {method, headers:{"content-type":"application/json"}, body:JSON.stringify({name:"test", baseURL:"http://127.0.0.1:14000/v1", ...input})});
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /不支持/);
    }
  }
  assert.equal(writes, 0);
});

test("historical or explicit text-as-image is blocked by image runtime", async () => {
  await assert.rejects(resolveImageModel("custom_local", "gpt-5"), /不支持图像生成/);
  assert.equal(await resolveImageModel("custom_local", "gpt-image-2"), "gpt-image-2");
  assert.equal(await resolveImageModel("custom_local", "gateway-image-alias"), "gateway-image-alias");
});

test("creating from an image-only catalog requires an explicit text model and makes no writes", async (t) => {
  const originalFind = prisma.aPIKey.findUnique, originalCreate = prisma.aPIKey.create;
  let writes = 0;
  prisma.aPIKey.findUnique = async () => null;
  prisma.aPIKey.create = async () => { writes++; };
  t.after(() => { prisma.aPIKey.findUnique = originalFind; prisma.aPIKey.create = originalCreate; });
  const httpFetch = global.fetch;
  t.mock.method(global, "fetch", async () => Response.json({data:[{id:"gpt-image-2"}, {id:"tts-1"}]}));
  const server = http.createServer(createApp());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await httpFetch(`http://127.0.0.1:${server.address().port}/api/settings/custom-providers`, {method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({name:"images only", baseURL:"https://example.test/v1"})});
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /未找到已确认的文本模型/);
  assert.equal(writes, 0);
});
