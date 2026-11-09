const test = require("node:test");
const assert = require("node:assert/strict");
const { prisma } = require("../dist/db/prisma");
const { llmConnectivityService } = require("../dist/llm/connectivity");
const { setProviderSecretCache } = require("../dist/llm/factory");

function configure(t, provider, baseURL) {
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
  assert.deepEqual(requests.map(({ body }) => body.stream), [false, true]);
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
      ? Response.json({ content: [{ type: "text", text: "ok" }] })
      : new Response("Not Found", { status: 404 });
  });
  const result = await llmConnectivityService.testConnection({ provider: "openai", probeMode: "plain" });
  assert.equal(result.plain.ok, true, result.error);
  assert.equal(result.requestProtocol, "anthropic");
  assert.deepEqual(paths, ["/v1/chat/completions", "/v1/messages"]);
});
