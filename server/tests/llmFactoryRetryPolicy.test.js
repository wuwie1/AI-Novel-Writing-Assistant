const test = require("node:test");
const assert = require("node:assert/strict");

const { createLLMFromResolvedOptions, resolveLLMClientOptions, setProviderSecretCache } = require("../dist/llm/factory.js");

test("official OpenAI preserves the output budget in each API and the supported sampling settings", async (t) => {
  setProviderSecretCache("openai", { key: "test-key", baseURL: "https://api.openai.com/v1" });
  t.after(() => setProviderSecretCache("openai", null));
  for (const [model, temperature] of [["gpt-6.1-sol", undefined], ["gpt-5", undefined], ["gpt-4o", 0.2]]) {
    const resolved = await resolveLLMClientOptions("openai", { model, temperature: 0.2, maxTokens: 3200 });
    const llm = createLLMFromResolvedOptions(resolved);
    const chat = llm.invocationParams({});
    assert.equal(chat.model, model);
    assert.equal(chat.max_completion_tokens, 3200);
    assert.equal(chat.max_tokens, undefined);
    assert.equal(chat.temperature, temperature);
    const responses = llm.invocationParams({ previous_response_id: "resp_test" });
    assert.equal(responses.max_output_tokens, 3200);
    assert.equal(responses.max_completion_tokens, undefined);
    assert.equal(responses.temperature, temperature);
  }
  const proxy = await resolveLLMClientOptions("openai", {
    baseURL: "https://gateway.example/v1", model: "gpt-6.1-sol", temperature: 0.2, maxTokens: 3200,
  });
  const chat = createLLMFromResolvedOptions(proxy).invocationParams({});
  assert.equal(chat.max_tokens, 3200);
  assert.equal(chat.temperature, 0.2);
});

test("Ollama saved thinking-off reaches SDK request parameters in text and structured modes", async (t) => {
  setProviderSecretCache("ollama", { model: "qwen3.5:9b", baseURL: "http://127.0.0.1:11434/v1", reasoningEnabled: false });
  t.after(() => setProviderSecretCache("ollama", null));
  for (const executionMode of ["plain", "structured"]) {
    const resolved = await resolveLLMClientOptions("ollama", { model: "qwen3.5:9b", executionMode, maxTokens: 3200 });
    const llm = createLLMFromResolvedOptions(resolved);
    const body = llm.invocationParams({});
    assert.equal(body.reasoning_effort, "none");
    assert.equal(body.max_tokens, 3200);
    assert.equal(body.think, undefined);
    assert.equal(body.enable_thinking, undefined);
  }
});

test("OpenAI-compatible clients leave retries to explicit product workflows", () => {
  const llm = createLLMFromResolvedOptions({
    provider: "custom",
    providerName: "Custom",
    model: "test-model",
    temperature: 0.2,
    baseURL: "http://127.0.0.1:1/v1",
    authMode: "none",
    concurrencyLimit: 1,
    requestIntervalMs: 0,
    reasoningEnabled: false,
    reasoningEffort: null,
    includeRawResponse: false,
    requestProtocol: "openai",
    executionMode: "text",
    structuredProfile: null,
    structuredStrategy: null,
    reasoningForcedOff: false,
  });

  assert.equal(llm.caller.maxRetries, 0);
});
