/** Connection contracts and input validation, not AI task/model routing. */
export const LOCAL_PROXY_BASE_URL = "http://127.0.0.1:14000/v1";
export function usesLocalProxy(baseURL?: string): boolean {
  return baseURL?.trim().replace(/\/+$/, "") === LOCAL_PROXY_BASE_URL;
}

export type ModelPurpose = "text" | "image";
export type ModelModality = ModelPurpose | "other" | "unknown";

/** Recognize documented model families only; an arbitrary gateway alias stays unknown.
 * Text input/vision capability does not imply image generation capability.
 */
export function modelModality(model?: string): ModelModality {
  const id = model?.trim().toLowerCase().split("/").at(-1) ?? "";
  if (/^(?:gpt-image-\d|chatgpt-image-latest$|dall-e-[23](?:$|-)|flux[.-]|grok-imagine-image(?:$|-)|qwen-image(?:$|-))/.test(id)) return "image";
  if (/^(?:text-embedding-|omni-moderation-|text-moderation-|tts-\d|whisper-\d|sora(?:$|-)|gpt-live(?:$|-))/.test(id)
    || /^gpt-\d.*(?:transcribe|tts|realtime|audio)/.test(id)) return "other";
  if (/^(?:gpt-4o(?:$|-)|gpt-[3456](?:$|[.-])|chatgpt-4o(?:$|-)|o[134](?:$|-)|claude(?:$|-)|deepseek(?:$|-))/.test(id)) return "text";
  return "unknown";
}

export function modelPurposeError(model: string | undefined, purpose: ModelPurpose): string | null {
  if (!model?.trim()) return null;
  const modality = modelModality(model);
  if (modality === "unknown" || modality === purpose) return null;
  return purpose === "text"
    ? `模型 ${model.trim()} 不支持文本对话，请选择文本模型；图像生成模型请填写到“图像模型”。`
    : `模型 ${model.trim()} 不支持图像生成，请选择图像模型；能够理解图片不代表能够生成图片。`;
}

export function assertModelPurpose(model: string | undefined, purpose: ModelPurpose): void {
  const error = modelPurposeError(model, purpose);
  if (error) throw new Error(error);
}

export function defaultTextModel(models: readonly string[]): string | undefined {
  // Unknown aliases require an explicit user selection, not an assumed capability.
  return models.find(model => modelModality(model) === "text");
}
