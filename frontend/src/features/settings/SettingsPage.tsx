import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@vantyr/ui/components/tabs";
import { api, errorText } from "@/api";
import { enrollmentKeys, enrollmentQueries } from "@/api/queries/enrollment";
import { settingsKeys, settingsQueries } from "@/api/queries/settings";
import { useSession } from "@/app/providers/useSession";
import { AgentEnrollmentSettings } from "@/features/enrollment/AgentEnrollmentSettings";
import type { PendingAgentClaim } from "@/features/enrollment/PendingApprovalsCard";
import { DataRetentionSettings } from "./DataRetentionSettings";
import { RecallCaptureSettings } from "@/features/recall/components/RecallCaptureSettings";
import { UrlCategorizationSettings } from "./UrlCategorizationSettings";
import { useRetentionSettings } from "./hooks/useRetentionSettings";
import { useUrlCategorization } from "./hooks/useUrlCategorization";
import { SecuritySettings } from "./SecuritySettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { BrowserPushToggle } from "./BrowserPushToggle";
import { SystemAboutSettings } from "./SystemAboutSettings";

type EnrollmentToken = Awaited<ReturnType<typeof api.listAgentEnrollmentTokens>>["tokens"][number];

const NO_TOKENS: EnrollmentToken[] = [];
const NO_CLAIMS: PendingAgentClaim[] = [];

/** The sections, in tab order; `hint` says what is inside so nobody opens each one to find out. */
const SECTIONS = [
  { id: "agents", label: "Agents", hint: "Enroll new devices and approve the ones waiting." },
  {
    id: "data",
    label: "Data",
    hint: "How long data is kept, screen capture defaults and website categories.",
  },
  {
    id: "alerts",
    label: "Alerts",
    hint: "Where alert matches are sent, and notifications on this browser.",
  },
  { id: "system", label: "System", hint: "Version, updates and storage." },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function isSection(value: string | null): value is SectionId {
  return SECTIONS.some((section) => section.id === value);
}

/** `e.message`, falling back to the value itself (the old loaders' error format). */
function messageOf(e: unknown): string {
  return String((e as { message?: string })?.message ?? e);
}

/** The message of a query error, or null when there is none. */
function errorMessage(error: unknown): string | null {
  return error ? messageOf(error) : null;
}

export function SettingsPage() {
  const { navUser: currentUser } = useSession();
  const queryClient = useQueryClient();
  const isAdmin = currentUser?.role === "admin";

  // The section lives in the address (?section=data) so reload, back and shared links land where you were.
  const [params, setParams] = useSearchParams();
  const requested = params.get("section");
  const section: SectionId = isSection(requested) ? requested : "agents";
  const hint = SECTIONS.find((s) => s.id === section)?.hint;

  // ── Retention (editable), storage and the global auto-update policy ───────
  const retention = useRetentionSettings(isAdmin);
  const storageQuery = useQuery(settingsQueries.storage());
  const autoUpdateQuery = useQuery(settingsQueries.autoUpdate());

  const saveGlobalAutoUpdate = async (enabled: boolean) => {
    if (!isAdmin) return;
    const res = await api.agentAutoUpdateGlobalPut({ enabled });
    queryClient.setQueryData(settingsKeys.autoUpdate(), res);
  };

  // ── Latest GitHub release ─────────────────────────────────────────────────
  const releaseQuery = useQuery(settingsQueries.releaseCheck());
  // A failed forced re-check keeps the last known release on screen (the query keeps its data).
  const checkGithubRelease = () =>
    void queryClient.fetchQuery(settingsQueries.releaseCheck(true)).then(
      () => undefined,
      () => undefined,
    );

  // ── URL categorization (admin) ────────────────────────────────────────────
  const urlCat = useUrlCategorization(isAdmin);

  // ── Enrollment (admin) ────────────────────────────────────────────────────
  const tokensQuery = useQuery({ ...enrollmentQueries.tokens(), enabled: isAdmin });
  const enrollTokens = tokensQuery.isError ? NO_TOKENS : (tokensQuery.data?.tokens ?? NO_TOKENS);
  const enrollTokensLoading = tokensQuery.isFetching;
  // `undefined` shows the list's own load error; the token actions report theirs here.
  const [enrollTokensActionError, setEnrollTokensError] = useState<string | null | undefined>(
    undefined,
  );
  const enrollTokensError = enrollmentError(enrollTokensActionError, tokensQuery.error);
  const loadEnrollmentTokens = async () => {
    if (!isAdmin) return;
    setEnrollTokensError(undefined);
    await tokensQuery.refetch();
  };

  const claimsQuery = useQuery({ ...enrollmentQueries.claims(), enabled: isAdmin });
  const enrollClaims: PendingAgentClaim[] = claimsQuery.isError
    ? NO_CLAIMS
    : (claimsQuery.data?.claims ?? NO_CLAIMS);
  const enrollClaimsLoading = claimsQuery.isFetching;
  const loadEnrollmentClaims = async () => {
    if (!isAdmin) return;
    await queryClient.invalidateQueries({ queryKey: enrollmentKeys.claims() });
  };

  const approveEnrollmentClaim = async (claim: PendingAgentClaim, agentName: string) => {
    if (!isAdmin) return;
    await api.approveAgentEnrollmentClaim(claim.id, { agent_name: agentName });
    await loadEnrollmentClaims();
  };

  const rejectEnrollmentClaim = async (claim: PendingAgentClaim) => {
    if (!isAdmin) return;
    await api.rejectAgentEnrollmentClaim(claim.id);
    await loadEnrollmentClaims();
  };

  return (
    <Tabs
      value={section}
      onValueChange={(next) => setParams({ section: String(next) }, { replace: true })}
      className="gap-4"
    >
      <TabsList aria-label="Settings sections">
        {SECTIONS.map(({ id, label }) => (
          <TabsTrigger key={id} value={id}>
            {label}
          </TabsTrigger>
        ))}
      </TabsList>
      <p className="text-sm text-muted-foreground">
        {hint}
        {!isAdmin && " You can view these settings; only admins can change them."}
      </p>

      {/* Panels stay mounted so a half-edited form survives switching tabs. */}
      <TabsContent value="agents" keepMounted className="flex flex-col gap-8">
        <AgentEnrollmentSettings
          isAdmin={isAdmin}
          enrollClaims={enrollClaims}
          enrollClaimsLoading={enrollClaimsLoading}
          enrollClaimsError={errorMessage(claimsQuery.error)}
          onRefreshClaims={loadEnrollmentClaims}
          onApproveClaim={approveEnrollmentClaim}
          onRejectClaim={rejectEnrollmentClaim}
          enrollTokens={enrollTokens}
          enrollTokensLoading={enrollTokensLoading}
          enrollTokensError={enrollTokensError}
          setEnrollTokensError={setEnrollTokensError}
          loadEnrollmentTokens={loadEnrollmentTokens}
          onGenerateToken={(body) => api.createAgentEnrollmentToken(body)}
          onRevokeToken={async (id) => {
            await api.revokeAgentEnrollmentToken(id);
          }}
          onRevokeAllTokens={async () => {
            await api.revokeAllAgentEnrollmentTokens();
          }}
          onListTokenUses={(id) => api.listAgentEnrollmentTokenUses(id).then((r) => r.uses ?? [])}
        />
        <SecuritySettings />
      </TabsContent>

      <TabsContent value="data" keepMounted className="flex flex-col gap-8">
        <DataRetentionSettings isAdmin={isAdmin} form={retention} />
        <RecallCaptureSettings isAdmin={isAdmin} />
        <UrlCategorizationSettings isAdmin={isAdmin} urlCat={urlCat} />
      </TabsContent>

      <TabsContent value="alerts" keepMounted className="flex flex-col gap-8">
        {/* This browser's switch is for everyone, so it leads for people who cannot configure channels. */}
        {!isAdmin && <BrowserPushToggle />}
        <NotificationsSettings isAdmin={isAdmin} />
        {isAdmin && <BrowserPushToggle />}
      </TabsContent>

      <TabsContent value="system" keepMounted className="flex flex-col gap-8">
        <SystemAboutSettings
          isAdmin={isAdmin}
          storage={{
            data: storageQuery.data ?? null,
            error: storageQuery.error ? errorText(storageQuery.error) : null,
            loading: storageQuery.isFetching,
            updatedAt: storageQuery.dataUpdatedAt,
            onReload: () => void storageQuery.refetch(),
          }}
          version={{
            data: releaseQuery.data ?? null,
            error: releaseQuery.error ? messageOf(releaseQuery.error) : null,
            loading: releaseQuery.isFetching,
            updatedAt: releaseQuery.dataUpdatedAt,
            onReload: checkGithubRelease,
          }}
          autoUpdate={{
            data: autoUpdateQuery.data ?? null,
            error: autoUpdateQuery.error ? errorText(autoUpdateQuery.error) : null,
            loading: autoUpdateQuery.isFetching,
            onReload: () => void autoUpdateQuery.refetch(),
            onSave: saveGlobalAutoUpdate,
          }}
        />
      </TabsContent>
    </Tabs>
  );
}

function enrollmentError(
  actionError: string | null | undefined,
  loadError: unknown,
): string | null {
  return actionError !== undefined ? actionError : loadError ? messageOf(loadError) : null;
}
