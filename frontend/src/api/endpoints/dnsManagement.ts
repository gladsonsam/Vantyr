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
  /**
   * `network_admin`. 409 on a stale `expected_config_version` or an `add_list` whose id exists with a
   * different source; 404 for an unknown `set_list`/`remove_list` id; 400 for malformed ids or config.
   * A no-op (including `add_list` of an identical existing source) returns `changed: false`.
   */
  dnsManagementPatch: (
    household: string,
    body: DnsManagementPatchBody,
  ): Promise<DnsManagementPatchResult> => patchJson(`${base(household)}/management`, body),
  /**
   * `network_admin`. 404 unknown list, 409 disabled. A repeat inside the cooldown is HTTP 200 with
   * `created: false` and the original `config_version` and `expires_at`, not an error.
   */
  dnsListRefresh: (household: string, sourceId: string): Promise<DnsRefreshResult> =>
    postJsonRes(`${base(household)}/lists/${encodeURIComponent(sourceId)}/refresh`, {}),
  /** `network_admin` or `network_events`. */
  dnsStatus: (household: string): Promise<DnsStatusView> => get(`${base(household)}/status`),
};
