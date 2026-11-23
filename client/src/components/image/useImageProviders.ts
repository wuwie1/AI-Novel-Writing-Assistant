import { useQuery } from "@tanstack/react-query";
import { queryKeys } from "@/api/queryKeys";
import { getAPIKeySettings, type APIKeyStatus } from "@/api/settings";
import { availableImageProviders } from "./imageProviderSelection";

const empty: APIKeyStatus[] = [];
const selectAvailable = (res: Awaited<ReturnType<typeof getAPIKeySettings>>) => availableImageProviders(res.data ?? []);

export function useImageProviders(enabled = true) {
  const { data } = useQuery({
    queryKey: queryKeys.settings.apiKeys,
    queryFn: getAPIKeySettings,
    select: selectAvailable,
    enabled,
  });
  return data ?? empty;
}
