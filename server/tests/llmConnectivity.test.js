const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma");
const { llmConnectivityService } = require("../dist/llm/connectivity");
const { setProviderSecretCache } = require("../dist/llm/factory");

function configure(t, provider, baseURL) {
  const findMany = prisma.appSetting.findMany, findUnique = prisma.appSetting.findUnique;
  prisma.appSetting.findMany = async () => [];
  prisma.appSetting.findUnique = async () => null;
  t.after(() => { prisma.appSetting.findMany = findMany; prisma.appSetting.findUnique = findUnique; });
  setProviderSecretCache(provider, { key: "test-key", model: "gpt-6.1-sol", baseURL });
  t.after(() => setProviderSecretCache(provider, null));
  const createUsage = prisma.llmInvocationUsageRecord.create;
  prisma.llmInvocationUsageRecord.create = async () => ({});
  t.after(() => { prisma.llmInvocationUsageRecord.create = createUsage; });
}

test("both probes use the saved OpenAI endpoint and serialize reasoning-model parameters", async (t) => {
  configure(t, "custom_direct", "https://api.openai.com/");
  const findRoute = prisma.modelRouteConfig.findUnique;
  prisma.modelRouteConfig.findUnique = async () => null;
  t.after(() => { prisma.modelRouteConfig.findUnique = findRoute; });
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    if (!body.stream) {
      return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
    }
    const delta = { role: "assistant", content: '{"status":"ok"}' };
    const chunk = { choices: [{ index: 0, delta, finish_reason: "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    });
  });
  const result = await llmConnectivityService.testConnection({
    provider: "custom_direct", requestProtocol: "anthropic", probeMode: "both",
  });
  assert.equal(result.plain.ok, true, result.plain.error);
  assert.equal(result.structured.ok, true, result.structured.error);
  assert.equal(result.structured.strategy, "json_schema");
  assert.deepEqual(requests.map(({ body }) => body.stream), [true, true]);
  for (const { url, body } of requests) {
    assert.equal(url, "https://api.openai.com/v1/chat/completions");
    assert.equal(body.model, "gpt-6.1-sol");
    assert.ok(body.max_completion_tokens > 16);
    assert.equal("max_tokens" in body, false);
    assert.equal("temperature" in body, false);
  }
});

test("an OpenAI model access error reaches the caller without an Anthropic probe", async (t) => {
  configure(t, "openai", "https://api.openai.com/v1");
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json({
    error: { message: "Selected model is unavailable for this key.", code: "model_not_found" },
  }, { status: 404 }));
  const result = await llmConnectivityService.testConnection({ provider: "openai", probeMode: "plain" });
  assert.equal(result.ok, false);
  assert.equal(result.requestProtocol, "openai_compatible");
  assert.match(result.error, /Selected model is unavailable for this key/);
  assert.equal(fetch.mock.callCount(), 1);
});

test("an OpenAI provider with a saved gateway can still discover the Anthropic protocol", async (t) => {
  configure(t, "openai", "https://gateway.example/v1");
  const paths = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const path = new URL(url).pathname;
    paths.push(path);
    return path === "/v1/messages"
      ? new Response('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n', {
        headers: { "content-type": "text/event-stream" },
      })
      : new Response("Not Found", { status: 404 });
  });
  const result = await llmConnectivityService.testConnection({ provider: "openai", probeMode: "plain" });
  assert.equal(result.plain.ok, true, result.error);
  assert.equal(result.requestProtocol, "anthropic");
  assert.deepEqual(paths, ["/v1/chat/completions", "/v1/messages"]);
});

test("local tunnel stays on OpenAI even with an Anthropic preference and preserves upstream errors", async (t) => {
  configure(t, "custom_local", "http://127.0.0.1:14000/v1/");
  const paths = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    paths.push(new URL(url).pathname);
    return Response.json({error: {message: "Original upstream error: insufficient_quota", code: "insufficient_quota"}}, {status: 429});
  });
  const result = await llmConnectivityService.testConnection({provider: "custom_local", requestProtocol: "anthropic", probeMode: "both"});
  assert.equal(result.ok, false);
  assert.equal(result.plain.requestProtocol, "openai_compatible");
  assert.equal(result.structured.requestProtocol, "openai_compatible");
  assert.match(result.error, /Original upstream error: insufficient_quota/);
  assert.match(result.structured.error, /Original upstream error: insufficient_quota/);
  assert.ok(paths.length >= 2);
  assert.ok(paths.every(path => path === "/v1/chat/completions"));
});

test("failed automatic protocol discovery keeps the first error", async (t) => {
  configure(t, "custom_errors", "https://gateway.example/v1");
  t.mock.method(globalThis, "fetch", async (url) => new URL(url).pathname.endsWith("/messages")
    ? new Response("Not Found", {status: 404})
    : Response.json({error: {message: "Original model permission denied"}}, {status: 403}));
  const result = await llmConnectivityService.testConnection({provider: "custom_errors", probeMode: "plain"});
  assert.match(result.error, /Original model permission denied/);
  assert.equal(result.requestProtocol, "openai_compatible");
});

test("historical image-as-text configuration fails before any network request", async (t) => {
  configure(t, "custom_bad_model", "http://127.0.0.1:14000/v1");
  const fetch = t.mock.method(globalThis, "fetch", async () => { throw new Error("must not call network"); });
  const result = await llmConnectivityService.testConnection({provider: "custom_bad_model", model: "gpt-image-2", probeMode: "both"});
  assert.match(result.error, /不支持文本对话/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("local OpenAI reasoning model can complete a streamed test with compatible parameters", async (t) => {
  configure(t, "custom_local_success", "http://127.0.0.1:14000/v1");
  t.mock.method(globalThis, "fetch", async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(new URL(url).pathname, "/v1/chat/completions");
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_tokens, undefined);
    assert.ok(body.max_completion_tokens >= 256);
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {headers:{"content-type":"text/event-stream"}});
  });
  const result = await llmConnectivityService.testConnection({provider:"custom_local_success", probeMode:"plain"});
  assert.equal(result.ok, true, result.error);
});
