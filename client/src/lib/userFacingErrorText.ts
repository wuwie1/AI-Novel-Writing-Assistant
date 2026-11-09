const STRUCTURED_OUTPUT_TAG = /^\s*\[STRUCTURED_OUTPUT:([a-z_]+)\]\s*/i;
const TRANSPORT_HINT = /connection error|fetch failed|timed? ?out|econnrefused|enotfound|network|socket hang up/i;

const STRUCTURED_OUTPUT_COPY: Record<string, string> = {
  transport_error: "暂时连不上 AI 模型服务，请检查网络或在设置中测试模型连接后重试。",
  unsupported_native_json: "当前模型不支持这类结构化输出，可以在设置中换一个模型后重试。",
  thinking_pollution: "AI 返回的内容混入了思考过程，没能整理成可用结果，请重试。",
  incomplete_json: "AI 返回的内容不完整，请重试。",
  malformed_json: "AI 返回的内容格式不对，请重试。",
  schema_mismatch: "AI 返回的内容缺少必要信息，请重试。",
};

const TRUNCATED_OUTPUT_COPY = "AI 这次输出的内容过长被截断，请重试；如果反复出现，可以在模型路由中调高输出上限。";
const BLOCKED_OUTPUT_COPY = "模型拒绝了这次请求，可以调整内容或在设置中换一个模型后重试。";

/** Translate stored runtime error text (including older records) into wording a writer can act on. */
export function toUserFacingErrorText(message: string | null | undefined): string {
  const text = message?.trim() ?? "";
  if (!text) return "";
  const tagged = text.match(STRUCTURED_OUTPUT_TAG);
  if (tagged) {
    const category = tagged[1].toLowerCase();
    const detail = text.slice(tagged[0].length);
    if (category === "transport_error" && detail.includes("长度上限")) return TRUNCATED_OUTPUT_COPY;
    if (category === "transport_error" && detail.includes("拦截")) return BLOCKED_OUTPUT_COPY;
    return STRUCTURED_OUTPUT_COPY[category] ?? (text.slice(tagged[0].length).trim() || "AI 处理没有完成，请重试。");
  }
  if (/^[\x20-\x7e]+$/.test(text) && TRANSPORT_HINT.test(text)) return STRUCTURED_OUTPUT_COPY.transport_error;
  return text;
}
