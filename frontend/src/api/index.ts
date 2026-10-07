import { createDemoApi } from "@/demo/api";
import { isDemoMode } from "@/demo/mode";
import { authEndpoints } from "@/api/endpoints/auth";
import { agentsEndpoints } from "@/api/endpoints/agents";
import { groupsEndpoints } from "@/api/endpoints/groups";
import { recallEndpoints } from "@/api/endpoints/recall";
import { remoteEndpoints } from "@/api/endpoints/remote";
import { modulesEndpoints } from "@/api/endpoints/modules";
import { settingsEndpoints } from "@/api/endpoints/settings";
import { enrollmentEndpoints } from "@/api/endpoints/enrollment";
import { urlCategoriesEndpoints } from "@/api/endpoints/urlCategories";
import { analyticsEndpoints } from "@/api/endpoints/analytics";
import { notificationsEndpoints } from "@/api/endpoints/notifications";
import { usersEndpoints } from "@/api/endpoints/users";
import { rulesEndpoints } from "@/api/endpoints/rules";
import { auditEndpoints } from "@/api/endpoints/audit";

export { ApiError, apiUrl, errorText, isApiError, setDashboardCsrfToken } from "./client";
export { historyRangeQuery, historySearchQuery, type HistoryRangeOpts, type HistorySearchOpts } from "@/api/endpoints/recall";
export { mjpegStreamUrl, notifyMjpegViewerLeft, type ClipboardReply, type ClipboardRequest, type MjpegStreamTuning } from "@/api/endpoints/remote";
export { SETTINGS_VERSION_POLL_INTERVAL_MS } from "@/api/endpoints/settings";

/** Every REST endpoint, composed from the per-domain modules in `./endpoints`. */
export const realApi = {
  ...authEndpoints,
  ...agentsEndpoints,
  ...groupsEndpoints,
  ...recallEndpoints,
  ...remoteEndpoints,
  ...modulesEndpoints,
  ...settingsEndpoints,
  ...enrollmentEndpoints,
  ...urlCategoriesEndpoints,
  ...analyticsEndpoints,
  ...notificationsEndpoints,
  ...usersEndpoints,
  ...rulesEndpoints,
  ...auditEndpoints,
};

export type ApiClient = typeof realApi;

export const api: ApiClient = isDemoMode ? createDemoApi(realApi) : realApi;
