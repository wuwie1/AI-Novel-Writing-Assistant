import type { APIKeyStatus } from "@/api/settings";
import { isLocalModelProvider } from "../../pages/settings/models/localProxy.ts";

export function availableImageProviders(providers: APIKeyStatus[]) {
  return providers
    .filter((item) => item.isActive && item.isConfigured && item.supportsImageGeneration && item.currentImageModel?.trim())
    .sort((a, b) => Number(isLocalModelProvider(b)) - Number(isLocalModelProvider(a)));
}

export function selectImageProvider(available: APIKeyStatus[], preferred?: string) {
  return (available.find((item) => item.provider === preferred) ?? available[0])?.provider ?? "";
}
