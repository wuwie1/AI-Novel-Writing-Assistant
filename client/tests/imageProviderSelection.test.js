import assert from "node:assert/strict";
import test from "node:test";
import { LOCAL_PROXY_BASE_URL } from "@ai-novel/shared/utils/modelConnection/index";
import { availableImageProviders, selectImageProvider } from "../src/components/image/imageProviderSelection.ts";

const remote = { provider: "openai", name: "本机模型", kind: "builtin", currentBaseURL: "https://example.org/v1",
  isConfigured: true, isActive: true, supportsImageGeneration: true, currentImageModel: "gpt-image-2" };
const local = { ...remote, provider: "custom_123", name: "我的画室", kind: "custom", currentBaseURL: LOCAL_PROXY_BASE_URL + "/" };

test("choose the local image connection by its endpoint, preserving any usable manual preference", () => {
  const available = availableImageProviders([remote, local]);
  assert.equal(selectImageProvider(available), local.provider);
  assert.equal(selectImageProvider(available, remote.provider), remote.provider);
});

test("a disabled saved provider or stale preview cannot become a selectable image provider", () => {
  const available = availableImageProviders([{ ...remote, isActive: false }, local]);
  assert.deepEqual(available, [local]);
  assert.equal(selectImageProvider(available, remote.provider), local.provider);
});

test("without a usable local image model choose the first available connection, or none", () => {
  for (const change of [{ isActive: false }, { isConfigured: false }, { supportsImageGeneration: false }, { currentImageModel: " " }]) {
    const unavailable = { ...local, ...change };
    assert.equal(selectImageProvider(availableImageProviders([unavailable, remote]), local.provider), remote.provider);
    assert.equal(selectImageProvider(availableImageProviders([unavailable])), "");
  }
});
