import test from "node:test";
import assert from "node:assert/strict";

import { toUserFacingErrorText } from "./userFacingErrorText.ts";

test("tagged structured-output errors become actionable writer-facing text", () => {
  assert.equal(
    toUserFacingErrorText("[STRUCTURED_OUTPUT:transport_error] Connection error."),
    "暂时连不上 AI 模型服务，请检查网络或在设置中测试模型连接后重试。",
  );
  assert.equal(toUserFacingErrorText("[STRUCTURED_OUTPUT:incomplete_json] cut"), "AI 返回的内容不完整，请重试。");
  assert.equal(toUserFacingErrorText("[STRUCTURED_OUTPUT:unknown_kind] 章节规划没有完成。"), "章节规划没有完成。");
});

test("raw English transport errors are translated while Chinese explanations are kept", () => {
  assert.equal(toUserFacingErrorText("Request timed out."), "暂时连不上 AI 模型服务，请检查网络或在设置中测试模型连接后重试。");
  assert.equal(toUserFacingErrorText("网络连接中断，请稍后继续。"), "网络连接中断，请稍后继续。");
  assert.equal(toUserFacingErrorText("   "), "");
  assert.equal(toUserFacingErrorText(null), "");
});

test("truncated and blocked model output is not described as a network problem", () => {
  assert.equal(
    toUserFacingErrorText("[STRUCTURED_OUTPUT:transport_error] 模型输出达到长度上限，结果不完整。"),
    "AI 这次输出的内容过长被截断，请重试；如果反复出现，可以在模型路由中调高输出上限。",
  );
  assert.equal(
    toUserFacingErrorText("[STRUCTURED_OUTPUT:transport_error] 模型拒绝或拦截了这次请求。"),
    "模型拒绝了这次请求，可以调整内容或在设置中换一个模型后重试。",
  );
});
