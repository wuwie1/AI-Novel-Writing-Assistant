import { LOCAL_PROXY_BASE_URL, usesLocalProxy } from "@ai-novel/shared/utils/modelConnection/index";
export { LOCAL_PROXY_BASE_URL, usesLocalProxy };

export type ProviderCreationKind = "custom" | "local";

export function newProviderConnection(kind: ProviderCreationKind) {
  return kind === "local"
    ? { displayName: "本机模型", baseURL: LOCAL_PROXY_BASE_URL }
    : { displayName: "", baseURL: "" };
}

export function isLocalModelProvider(provider?: { kind: string; currentBaseURL: string }): boolean {
  return provider?.kind === "custom" && usesLocalProxy(provider.currentBaseURL);
}
