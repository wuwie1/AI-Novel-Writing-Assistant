import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { z } from "zod";
import type { LLMProvider, ProviderAuthMode } from "@ai-novel/shared/types/llm";
import type {
  ModelRouteRequestProtocol,
  ModelRouteStructuredResponseFormat,
  ModelRouteTaskType,
} from "@ai-novel/shared/types/novel";
import { getLLM, resolveLLMClientOptions, type ResolvedLLMClientOptions } from "./factory";
import { usesOpenAIReasoningByDefault } from "./openai/chatClient";
import { isOfficialOpenAIBaseUrl } from "./providers";
import {
  MODEL_ROUTE_TASK_TYPES,
  resolveModel,
  toStructuredOutputStrategy,
  upsertModelRouteConfig,
} from "./modelRouter";
import { invokeStructuredLlmDetailed, summarizeStructuredOutputFailure } from "./structuredInvoke";
import {
  resolveStructuredOutputProfile,
  selectStructuredOutputStrategy,
  type StructuredOutputStrategy,
} from "./structuredOutput";

export type ConnectivityProbeMode = "plain" | "structured" | "both";

const STRUCTURED_PROBE_SCHEMA = z.object({
  status: z.literal("ok"),
});

export interface ConnectivityProbeStatus {
  ok: boolean;
  latency: number | null;
  error: string | null;
  requestProtocol: ModelRouteRequestProtocol | null;
}

export interface StructuredConnectivityProbeStatus extends ConnectivityProbeStatus {
  strategy: string | null;
  reasoningForcedOff: boolean;
  fallbackAvailable: boolean;
  fallbackUsed: boolean;
  errorCategory: string | null;
  nativeJsonObject: boolean;
  nativeJsonSchema: boolean;
  profileFamily: string | null;
}

export interface LLMConnectivityStatus extends ConnectivityProbeStatus {
  provider: LLMProvider;
  model: string;
  plain: ConnectivityProbeStatus | null;
  structured: StructuredConnectivityProbeStatus | null;
}

export interface ModelRouteConnectivityStatus extends LLMConnectivityStatus {
  taskType: ModelRouteTaskType;
}

function toErrorMessage(error: unknown): string {
  const raw = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "";
  if (!raw) {
    return "连接测试失败。";
  }
  if (/fetch failed|connection error|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(raw)) {
    return "无法连接到模型服务。请确认网络可用、服务地址正确，本机服务（如 Ollama）已启动。";
  }
  return raw;
}

function getProtocolCandidates(baseURL: string, preferred?: ModelRouteRequestProtocol): ModelRouteRequestProtocol[] {
  if (isOfficialOpenAIBaseUrl(baseURL)) {
    return ["openai_compatible"];
  }
  if (preferred === "openai_compatible" || preferred === "anthropic") {
    return [preferred, preferred === "anthropic" ? "openai_compatible" : "anthropic"];
  }
  return ["openai_compatible", "anthropic"];
}

function getStructuredFormatCandidates(input: {
  provider: LLMProvider;
  model?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  requestProtocol: ModelRouteRequestProtocol;
  preferred?: ModelRouteStructuredResponseFormat;
}): ModelRouteStructuredResponseFormat[] {
  if (input.requestProtocol === "anthropic") {
    return ["prompt_json"];
  }
  const profile = resolveStructuredOutputProfile({
    provider: input.provider,
    model: input.model,
    baseURL: input.baseURL,
    requestProtocol: input.requestProtocol,
    executionMode: "structured",
  });
  const profileFirst = selectStructuredOutputStrategy(profile, STRUCTURED_PROBE_SCHEMA);
  const fallbackOrder: StructuredOutputStrategy[] = profileFirst === "json_schema"
    ? ["json_schema", "json_object", "prompt_json"]
    : profileFirst === "json_object"
      ? ["json_object", "prompt_json", "json_schema"]
      : ["prompt_json", "json_object", "json_schema"];
  const preferred = input.preferred;
  if (preferred === "json_schema" || preferred === "json_object" || preferred === "prompt_json") {
    return [preferred, ...fallbackOrder].filter((value, index, array) => array.indexOf(value) === index);
  }
  return fallbackOrder;
}

type ProbeTarget = Pick<ResolvedLLMClientOptions, "provider" | "model" | "apiKey" | "baseURL" | "authMode">;

async function testPlainConnection(
  target: ProbeTarget,
  requestProtocol: ModelRouteRequestProtocol,
  maxTokens: number,
): Promise<ConnectivityProbeStatus> {
  try {
    const llm = await getLLM(target.provider, { ...target, temperature: 0.1, maxTokens, requestProtocol });
    const start = Date.now();
    await llm.invoke([new HumanMessage("请只回复 ok")]);
    return { ok: true, latency: Date.now() - start, error: null, requestProtocol };
  } catch (error) {
    return { ok: false, latency: null, error: toErrorMessage(error), requestProtocol };
  }
}

function failedStructuredProbe(error: unknown, requestProtocol: ModelRouteRequestProtocol | null): StructuredConnectivityProbeStatus {
  const summary = summarizeStructuredOutputFailure({ error, fallbackAvailable: false });
  return {
    ok: false,
    latency: null,
    error: toErrorMessage(error),
    requestProtocol,
    strategy: null,
    reasoningForcedOff: false,
    fallbackAvailable: false,
    fallbackUsed: false,
    errorCategory: summary.category,
    nativeJsonObject: false,
    nativeJsonSchema: false,
    profileFamily: null,
  };
}

async function testStructuredConnection(
  target: ProbeTarget,
  requestProtocol: ModelRouteRequestProtocol,
  structuredResponseFormat: ModelRouteStructuredResponseFormat,
  maxTokens: number,
): Promise<StructuredConnectivityProbeStatus> {
  try {
    const startedAt = Date.now();
    const result = await invokeStructuredLlmDetailed({
      ...target,
      temperature: 0.2,
      maxTokens,
      taskType: "planner",
      requestProtocol,
      structuredStrategy: toStructuredOutputStrategy(structuredResponseFormat) ?? undefined,
      label: "llm.connectivity.structured_probe",
      schema: STRUCTURED_PROBE_SCHEMA,
      messages: [
        new SystemMessage("你正在执行结构化输出兼容性探针。必须只输出合法 JSON。"),
        new HumanMessage("请输出一个 JSON 对象，字段 status 的值必须是 ok。"),
      ],
      maxRepairAttempts: 1,
      disableFallbackModel: true,
    });
    return {
      ok: true,
      latency: Date.now() - startedAt,
      error: null,
      requestProtocol,
      strategy: result.diagnostics.strategy,
      reasoningForcedOff: result.diagnostics.reasoningForcedOff,
      fallbackAvailable: result.diagnostics.fallbackAvailable,
      fallbackUsed: result.diagnostics.fallbackUsed,
      errorCategory: null,
      nativeJsonObject: result.diagnostics.profile.nativeJsonObject,
      nativeJsonSchema: result.diagnostics.profile.nativeJsonSchema,
      profileFamily: result.diagnostics.profile.family,
    };
  } catch (error) {
    return failedStructuredProbe(error, requestProtocol);
  }
}

async function testConnection(input: {
  provider: LLMProvider;
  model?: string;
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  probeMode?: ConnectivityProbeMode;
  requestProtocol?: ModelRouteRequestProtocol;
  structuredResponseFormat?: ModelRouteStructuredResponseFormat;
}): Promise<LLMConnectivityStatus> {
  const probeMode = input.probeMode ?? "both";
  let target: ProbeTarget;
  try {
    const { provider, model, apiKey, baseURL, authMode } = await resolveLLMClientOptions(input.provider, input);
    target = { provider, model, apiKey, baseURL, authMode };
  } catch (error) {
    const failure = { ok: false, latency: null, error: toErrorMessage(error), requestProtocol: null };
    return {
      ...failure,
      provider: input.provider,
      model: input.model?.trim() ?? "",
      plain: probeMode === "structured" ? null : failure,
      structured: probeMode === "plain" ? null : failedStructuredProbe(error, null),
    };
  }

  const protocols = getProtocolCandidates(target.baseURL, input.requestProtocol);
  // A reasoning model's output limit includes tokens spent before the visible reply.
  const reasoningProbe = isOfficialOpenAIBaseUrl(target.baseURL) && usesOpenAIReasoningByDefault(target.model);
  let plain: ConnectivityProbeStatus | null = null;
  let structured: StructuredConnectivityProbeStatus | null = null;
  if (probeMode !== "structured") {
    for (const requestProtocol of protocols) {
      plain = await testPlainConnection(target, requestProtocol, reasoningProbe ? 256 : 16);
      if (plain.ok) break;
    }
  }
  if (probeMode !== "plain") {
    for (const requestProtocol of protocols) {
      for (const format of getStructuredFormatCandidates({ ...target, requestProtocol, preferred: input.structuredResponseFormat })) {
        structured = await testStructuredConnection(target, requestProtocol, format, reasoningProbe ? 512 : 256);
        if (structured.ok) break;
      }
      if (structured?.ok) break;
    }
  }
  const status = plain ?? structured!;
  return {
    provider: target.provider,
    model: target.model,
    ok: status.ok,
    latency: status.latency,
    error: status.error,
    requestProtocol: status.requestProtocol,
    plain,
    structured,
  };
}

async function testModelRoutes(taskTypes: readonly ModelRouteTaskType[] = MODEL_ROUTE_TASK_TYPES): Promise<{
  testedAt: string;
  statuses: ModelRouteConnectivityStatus[];
}> {
  const resolvedRoutes = await Promise.all(taskTypes.map(async (taskType) => ({
    taskType,
    ...(await resolveModel(taskType)),
  })));

  const dedupedChecks = new Map<string, Promise<LLMConnectivityStatus>>();
  for (const route of resolvedRoutes) {
    const key = [
      route.provider,
      route.model,
      route.requestProtocol,
      route.structuredResponseFormat,
    ].join("::");
    if (!dedupedChecks.has(key)) {
      dedupedChecks.set(key, testConnection({
        provider: route.provider,
        model: route.model,
        requestProtocol: route.requestProtocol,
        structuredResponseFormat: route.structuredResponseFormat,
        probeMode: "both",
      }));
    }
  }

  const statuses = await Promise.all(resolvedRoutes.map(async (route) => {
    const key = [
      route.provider,
      route.model,
      route.requestProtocol,
      route.structuredResponseFormat,
    ].join("::");
    const result = await dedupedChecks.get(key)!;
    const effectiveProtocol = result.structured?.requestProtocol ?? result.plain?.requestProtocol ?? route.requestProtocol;
    const effectiveFormat = (
      result.structured?.strategy === "json_schema"
      || result.structured?.strategy === "json_object"
      || result.structured?.strategy === "prompt_json"
    )
      ? result.structured.strategy
      : route.structuredResponseFormat;
    const shouldPersistProbeResult = result.structured?.ok === true
      && (effectiveProtocol !== route.requestProtocol || effectiveFormat !== route.structuredResponseFormat);
    if (shouldPersistProbeResult) {
      await upsertModelRouteConfig(route.taskType, {
        provider: route.provider,
        model: route.model,
        temperature: route.temperature,
        maxTokens: route.maxTokens,
        requestProtocol: effectiveProtocol,
        structuredResponseFormat: effectiveFormat,
      });
    }
    return {
      taskType: route.taskType,
      provider: route.provider,
      model: route.model,
      ok: result.ok,
      latency: result.latency,
      error: result.error,
      requestProtocol: result.requestProtocol,
      plain: result.plain,
      structured: result.structured,
    };
  }));

  return {
    testedAt: new Date().toISOString(),
    statuses,
  };
}

export const llmConnectivityService = {
  testConnection,
  testModelRoutes,
};
