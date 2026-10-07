import { createDemoApi } from "@/demo/api";
import { isDemoMode } from "@/demo/mode";
import { authEndpoints } from "./endpoints/auth";
import { agentsEndpoints } from "./endpoints/agents";
import { groupsEndpoints } from "./endpoints/groups";
import { recallEndpoints } from "./endpoints/recall";
import { remoteEndpoints } from "./endpoints/remote";
import { modulesEndpoints } from "./endpoints/modules";
import { settingsEndpoints } from "./endpoints/settings";
import { enrollmentEndpoints } from "./endpoints/enrollment";
import { urlCategoriesEndpoints } from "./endpoints/urlCategories";
import { analyticsEndpoints } from "./endpoints/analytics";
import { notificationsEndpoints } from "./endpoints/notifications";
import { usersEndpoints } from "./endpoints/users";
import { rulesEndpoints } from "./endpoints/rules";
import { auditEndpoints } from "./endpoints/audit";

export { ApiError, apiUrl, errorText, isApiError, setDashboardCsrfToken } from "./client";
export { historyRangeQuery, historySearchQuery, type HistoryRangeOpts, type HistorySearchOpts } from "./endpoints/recall";
export { mjpegStreamUrl, notifyMjpegViewerLeft, type ClipboardReply, type ClipboardRequest, type MjpegStreamTuning } from "./endpoints/remote";
export { SETTINGS_VERSION_POLL_INTERVAL_MS } from "./endpoints/settings";

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
