import type { ApiClient } from "@/api";
import { notifyAgentRemoved } from "@/api/agentEvents";
import type { FleetSummaryResponse } from "@/api/types";
import {
  demoActivity,
  demoAgentInfo,
  demoAgents,
  demoAppBlockRules,
  demoGroups,
  demoKeys,
  demoSoftware,
  demoUrls,
  demoWindows,
  isoMinutesAgo,
} from "@/demo/data";
import { asRecord, asStringArray, page } from "./helpers";
import type { DemoState } from "./state";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Synthetic log lines, one of them very long, so the viewer's scrolling and wrapping can be tried. */
function demoLogText(agentId: string, kind: string): string {
  if (kind === "ui") return `[demo] settings UI started for ${agentId}\n[demo] UI idle\n`;
  const levels = ["INFO", "INFO", "INFO", "WARN", "INFO", "ERROR"];
  const lines = Array.from({ length: 240 }, (_, i) => {
    const time = new Date(Date.UTC(2026, 0, 2, 10, 0, 0) + i * 7000).toISOString().slice(11, 19);
    return `${time} ${levels[i % levels.length]} demo.module${i % 5}: telemetry batch ${i} uploaded for ${agentId}`;
  });
  lines.splice(
    12,
    0,
    `10:01:30 WARN demo.paths: could not read C:\\Users\\demo-user\\AppData\\Local\\Vantyr\\cache\\very\\deeply\\nested\\folder\\structure\\that\\keeps\\going\\and\\going\\until\\the\\line\\is\\far\\wider\\than\\any\\screen\\file-0001.tmp (access denied)`,
  );
  return `${lines.join("\n")}\n`;
}

/** Fake device reply: a pending pause, then success, a non-zero exit, or a timeout depending on what was typed. */
async function demoScriptReply(script: string): Promise<Record<string, unknown>> {
  await wait(900);
  if (/timeout/i.test(script))
    return { ok: false, error: "The script timed out after 120 seconds.", stdout: "", stderr: "" };
  if (/fail/i.test(script))
    return {
      ok: false,
      exit_code: 1,
      stdout: "Checking…\n",
      stderr: "demo: the service could not be reached\n",
    };
  if (/silent/i.test(script)) return { ok: true, exit_code: 0, stdout: "", stderr: "" };
  const long = "x".repeat(200);
  return {
    ok: true,
    exit_code: 0,
    stdout: `Demo script completed\n${long}\n${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\n`,
    stderr: "",
  };
}

/** Fake agents, fleet summary, history reads, scripts and software endpoints. */
export function demoAgentsApi(state: DemoState): Partial<ApiClient> {
  const { configuredInternet, removedAgents } = state;
  return {
    agentsOverview: async () => ({
      agents: demoAgents.filter((agent) => !removedAgents.has(agent.id)),
    }),
    fleetSummary: async (rawIds, signal) => {
      if ((signal as AbortSignal | undefined)?.aborted)
        throw new DOMException("Aborted", "AbortError");
      const ids = [...new Set(asStringArray(rawIds))].sort();
      if (
        !ids.length ||
        ids.length > 100 ||
        ids.some((id) => !id || id.includes(",")) ||
        ids.join(",").length > 8192
      )
        throw new Error("Fleet summary requires 1–100 agent IDs");
      const result: FleetSummaryResponse = { agents: {}, missing: [] };
      const groups = new Set(demoGroups.slice(0, 2).map((group) => group.id));
      const agentsById = new Map(demoAgents.map((agent) => [agent.id, agent]));
      for (const id of ids) {
        const agent = agentsById.get(id);
        if (!agent || removedAgents.has(id)) {
          result.missing.push(id);
          continue;
        }
        const info = demoAgentInfo[id] ?? null,
          window = demoWindows(id, 1)[0];
        const network = configuredInternet(id);
        result.agents[id] = {
          info: info ? structuredClone(info) : null,
          info_reported_at: info
            ? typeof info.ts === "number"
              ? new Date(info.ts * 1000).toISOString()
              : agent.last_seen
            : null,
          last_window: window
            ? { app: window.app, title: window.title, reported_at: window.ts }
            : null,
          internet_blocked: network.blocked,
          internet_block_source: network.source,
          app_block_enabled_count: new Set(
            demoAppBlockRules
              .filter(
                (rule) =>
                  rule.enabled &&
                  (rule.scopes ?? []).some(
                    (scope) =>
                      scope.kind === "all" ||
                      (scope.kind === "agent" && scope.agent_id === id) ||
                      (scope.kind === "group" && groups.has(scope.group_id ?? "")),
                  ),
              )
              .map((rule) => rule.id),
          ).size,
        };
      }
      return result;
    },
    agentIconGet: async (id) => ({ icon: demoAgents.find((a) => a.id === id)?.icon ?? null }),
    agentIconPut: async (_id, icon) => ({ icon }),
    windows: async (id, params) => ({ rows: page(demoWindows(String(id), 120), params) }),
    keys: async (id, params) => ({ rows: page(demoKeys(String(id), 80), params) }),
    urls: async (id, params) => ({ rows: page(demoUrls(String(id), 120), params) }),
    activity: async (id, params) => ({ rows: page(demoActivity(String(id), 80), params) }),
    agentInfo: async (id) => ({ info: demoAgentInfo[String(id)] ?? null }),
    agentMetrics: async (id, fromIso, toIso) => {
      const to = typeof toIso === "string" ? new Date(toIso).getTime() : Date.now();
      const from =
        typeof fromIso === "string" ? new Date(fromIso).getTime() : to - 24 * 3600 * 1000;
      const span = Math.max(60_000, to - from);
      const n = 240;
      const step = span / n;
      const memTotalMb = 16_384;
      const diskTotalGb = 475.5;
      const seed = String(id).length;
      const points = Array.from({ length: n }, (_, i) => {
        const t = Math.floor((from + i * step) / 1000);
        const phase = (i / n) * Math.PI * 2;
        const cpu = Math.max(
          2,
          Math.min(
            98,
            28 +
              22 * Math.sin(phase * 3 + seed) +
              14 * Math.sin(phase * 11) +
              (Math.random() * 10 - 5),
          ),
        );
        const memPct = Math.max(
          20,
          Math.min(95, 55 + 12 * Math.sin(phase * 2 + seed) + (Math.random() * 6 - 3)),
        );
        const diskPct = Math.max(40, Math.min(92, 68 + (i / n) * 4));
        return {
          t,
          cpu_pct: Math.round(cpu * 10) / 10,
          mem_pct: Math.round(memPct * 10) / 10,
          mem_used_mb: Math.round((memTotalMb * memPct) / 100),
          mem_total_mb: memTotalMb,
          disk_pct: Math.round(diskPct * 10) / 10,
          disk_used_gb: Math.round(((diskTotalGb * diskPct) / 100) * 10) / 10,
          disk_total_gb: diskTotalGb,
        };
      });
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        bucket_secs: Math.round(step / 1000),
        points,
      };
    },
    topUrls: async (id) => ({
      rows: demoUrls(String(id), 12).map((u, index) => ({
        url: u.url,
        visit_count: 35 - index * 2,
        last_ts: u.ts,
      })),
    }),
    topWindows: async (id) => ({
      rows: demoWindows(String(id), 12).map((w, index) => ({
        app: w.app,
        app_display: w.app_display,
        title: w.title,
        focus_count: 28 - index,
        last_ts: w.ts,
      })),
    }),
    clearAgentHistory: async () => ({ cleared_rows: 240 }),
    wakeAgent: async (id) => ({
      ok: true,
      mac: demoAgentInfo[String(id)]?.adapters?.[0]?.mac ?? "02-00-5E-10-00-00",
      broadcast: "255.255.255.255",
      port: 9,
    }),
    deleteAgents: async (ids) => {
      const selected = asStringArray(ids);
      selected.forEach((id) => {
        removedAgents.add(id);
        notifyAgentRemoved(id);
      });
      return { ok: true, deleted: new Set(selected).size };
    },
    agentSoftware: async (id) => ({
      rows: demoSoftware(String(id)),
      last_captured_at: isoMinutesAgo(7),
      total: 5,
      limit: 100,
      offset: 0,
    }),
    collectAgentSoftware: async () => ({ ok: true }),
    runAgentScript: async (_id, body) => demoScriptReply(String(asRecord(body).script ?? "")),
    agentLogSources: async () => ({
      sources: [
        { id: "agent", label: "Agent log", path: "C:\\ProgramData\\Vantyr\\agent.log" },
        { id: "ui", label: "Settings UI log", path: "C:\\ProgramData\\Vantyr\\ui.log" },
      ],
    }),
    agentLogTail: async (id, params) => {
      const kind = String(asRecord(params).kind ?? "agent");
      return { kind, text: demoLogText(String(id), kind) };
    },
    bulkAgentScript: async (body) => ({
      results: asStringArray(asRecord(body).agent_ids).map((agentId) => ({
        agent_id: agentId,
        ok: true,
        stdout: "Demo bulk script completed",
      })),
    }),
  };
}
