import type { ApiClient } from "@/api";
import { demoAgentsApi } from "./agents";
import { demoAnalyticsApi } from "./analytics";
import { demoAuditApi } from "./audit";
import { demoAuthApi } from "./auth";
import { demoEnrollmentApi } from "./enrollment";
import { demoGroupsApi } from "./groups";
import { demoModulesApi } from "./modules";
import { demoNotificationsApi } from "./notifications";
import { demoRecallApi } from "./recall";
import { demoRemoteApi } from "./remote";
import { demoRulesApi } from "./rules";
import { demoSettingsApi } from "./settings";
import { demoUrlCategoriesApi } from "./urlCategories";
import { demoUsersApi } from "./users";
import { createDemoState } from "./state";

/**
 * The fake server: per-domain overrides (mirroring `src/api/endpoints`) composed over the real
 * client. Any method without an override resolves to `{ ok: true }` so the demo never hits the network.
 */
export function createDemoApi(realApi: ApiClient): ApiClient {
  const state = createDemoState();
  const overrides: Partial<ApiClient> = {
    ...demoAgentsApi(state),
    ...demoAnalyticsApi(),
    ...demoAuditApi(),
    ...demoAuthApi(),
    ...demoEnrollmentApi(),
    ...demoGroupsApi(),
    ...demoModulesApi(state),
    ...demoNotificationsApi(),
    ...demoRecallApi(state),
    ...demoRemoteApi(state),
    ...demoRulesApi(state),
    ...demoSettingsApi(),
    ...demoUrlCategoriesApi(),
    ...demoUsersApi(),
  };

  // Flag each fallback once in dev so a missing override is noticed.
  const warnedFallbacks = new Set<string>();
  const client: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(realApi)) {
    if (name in overrides) client[name] = overrides[name as keyof ApiClient];
    else if (typeof value === "function") {
      client[name] = async () => {
        if (import.meta.env.DEV && !warnedFallbacks.has(name)) {
          warnedFallbacks.add(name);
          console.warn(`[demo] api.${name} has no demo override; returning { ok: true }`);
        }
        return { ok: true };
      };
    } else client[name] = value;
  }
  return client as ApiClient;
}
