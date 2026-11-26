import { get, patchJson, postJsonRes } from "@/api/client";
import type {
  DnsManagementPatchBody,
  DnsManagementPatchResult,
  DnsManagementView,
  DnsRefreshResult,
  DnsStatusView,
} from "@/api/types";

const base = (household: string) => `/network/households/${household}/dns`;

/** DNS management: desired config, delivery, manual list refresh and reported worker status. */
export const dnsManagementEndpoints = {
  /** `network_admin`. `desired: null` means nothing saved yet, not unavailable. */
  dnsManagement: (household: string): Promise<DnsManagementView> =>
    get(`${base(household)}/management`),
  /** `network_admin`. 409 on a stale `expected_config_version`; a no-op returns `changed: false`. */
  dnsManagementPatch: (
    household: string,
    body: DnsManagementPatchBody,
  ): Promise<DnsManagementPatchResult> =>
    patchJson(`${base(household)}/management`, body),
  /** `network_admin`. 404 unknown list, 409 disabled, 429 cooldown (`ApiError.retryAfterSecs`). */
  dnsListRefresh: (household: string, sourceId: string): Promise<DnsRefreshResult> =>
    postJsonRes(`${base(household)}/lists/${encodeURIComponent(sourceId)}/refresh`, {}),
  /** `network_admin` or `network_events`. */
  dnsStatus: (household: string): Promise<DnsStatusView> => get(`${base(household)}/status`),
};
