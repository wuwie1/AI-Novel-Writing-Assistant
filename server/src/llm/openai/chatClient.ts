import { ChatOpenAI, ChatOpenAICompletions, type ChatOpenAIFields } from "@langchain/openai";
import { isOfficialOpenAIBaseUrl } from "../providers";

class OfficialChatCompletions extends ChatOpenAICompletions {
  override invocationParams(...args: Parameters<ChatOpenAICompletions["invocationParams"]>) {
    // LangChain still emits max_tokens for model families it doesn't recognize.
    const { max_tokens, ...params } = super.invocationParams(...args);
    if (max_tokens != null) {
      params.max_completion_tokens = max_tokens;
    }
    return params;
  }
}

export function usesOpenAIReasoningByDefault(model: string): boolean {
  const family = model.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return ["gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro"].includes(family)
    || /^(?:gpt-6|gpt-5\.[56]|o[134])(?:[.-]|$)/.test(family);
}

export function createOpenAICompatibleChat(
  fields: ChatOpenAIFields & { model: string; configuration: { baseURL: string } },
): ChatOpenAI {
  if (!isOfficialOpenAIBaseUrl(fields.configuration.baseURL)) {
    return new ChatOpenAI(fields);
  }
  const effort = fields.modelKwargs?.reasoning_effort ?? fields.reasoning?.effort;
  const reasoning = effort == null ? usesOpenAIReasoningByDefault(fields.model) : effort !== "none";
  const options = {
    ...fields,
    temperature: reasoning ? undefined : fields.temperature,
  };
  return new ChatOpenAI({ ...options, completions: new OfficialChatCompletions(options) });
}
