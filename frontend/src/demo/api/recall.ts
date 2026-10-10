import type { ApiClient } from "@/api";
import {
  asciiLower,
  contextFiltersActive,
  parseRecallContext,
  parseRecallFilters,
  recallContextKnown,
} from "@/features/recall/lib/recallContext";
import { demoAgents } from "@/demo/data";
import { asRecord } from "./helpers";
import { DEMO_FRAME_STEP_MS, demoFrame, demoFrameDataUri, demoFramesList, demoRange, demoRecallSettings, demoSegments, demoTimezone, demoToday } from "./recallFixtures";
import type { DemoState } from "./state";

/** Fake recall history, search and settings endpoints. */
export function demoRecallApi(state: DemoState): Partial<ApiClient> {
  const { recallSearchPages, removedAgents } = state;
  return {
    historyDevices: async () => ({ agent_ids: demoAgents.filter((agent) => !removedAgents.has(agent.id)).map((agent) => agent.id) }),
    // ── Screen history / "Recall" ──
    historyFrames: async (_id, opts) => {
      const { from, to, limit } = demoRange(opts);
      let frames = demoFramesList(from, to);
      const after = Number(String(asRecord(opts).cursor ?? "0").replace(/^demo:/, ""));
      frames = frames.filter((frame) => frame.id > after);
      const cap = limit > 0 ? limit : 3000;
      const hasMore = frames.length > cap;
      frames = frames.slice(0, cap);
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        monitor: null,
        count: frames.length,
        frames,
        limit: cap,
        has_more: hasMore,
        complete: !hasMore,
        next_cursor: hasMore ? `demo:${frames[frames.length - 1].id}` : null,
      };
    },
    historyFrameAt: async (_id, atIso) => {
      const at = typeof atIso === "string" ? new Date(atIso).getTime() : Date.now();
      const t = Math.round(at / DEMO_FRAME_STEP_MS) * DEMO_FRAME_STEP_MS;
      return { frame: demoFrame(t) };
    },
    historySearch: async (_id, query, opts) => {
      const q=String(query ?? "").trim(), o=asRecord(opts);
      const cursor=typeof o.cursor==="string" ? o.cursor : null;
      const match=cursor?.match(/^demo-search:([a-f0-9-]+):(\d+)$/);
      const previous=match ? recallSearchPages.get(match[1]) : undefined;
      const offset=match ? Number(match[2]) : 0;
      if(cursor&&(!previous||!Number.isSafeInteger(offset)||offset<0||offset>previous.results.length))throw new Error("Demo search cursor expired or invalid. Search again.");
      const filterInput={app:o.app,app_mode:o.app_mode,title:o.title,url_host:o.url_host,context:o.context};
      const inherited={...previous?.filters};
      for(const [key,value] of Object.entries(filterInput))if(value!==undefined)Object.assign(inherited,{[key]:value});
      const filters=parseRecallFilters(previous ? inherited : filterInput);
      const scope=o.scope ?? previous?.scope ?? "range", sort=o.sort ?? previous?.sort ?? (q ? "ranked" : "newest");
      const monitor=o.monitor===undefined ? previous?.monitor ?? null : o.monitor;
      if(typeof scope!=="string"||!["range","retained"].includes(scope)||typeof sort!=="string"||!["ranked","newest"].includes(sort)||!(monitor===null||Number.isSafeInteger(monitor)&&Number(monitor)>=0&&Number(monitor)<64))throw new Error("Invalid demo search scope, sort or display");
      if(!q&&(!contextFiltersActive(filters)||sort==="ranked"))throw new Error("Context-only search requires a filter and newest order");
      if(new TextEncoder().encode(q).length>4096)throw new Error("OCR query exceeds 4096 bytes");
      const range=demoRange(opts), from=previous?.from ?? range.from, to=previous?.to ?? range.to;
      if(previous&&(previous.device!==String(_id)||previous.query!==q||previous.scope!==scope||previous.sort!==sort||previous.monitor!==monitor||JSON.stringify(previous.filters)!==JSON.stringify(filters)||(o.from!==undefined&&Date.parse(String(o.from))!==from)||(o.to!==undefined&&Date.parse(String(o.to))!==to)))throw new Error("Demo search cursor filters do not match. Search again.");
      if(!Number.isFinite(from)||!Number.isFinite(to)||from>=to||scope==="retained"&&o.from!==undefined)throw new Error("Invalid demo search bounds");
      const cap=o.limit===undefined ? 100 : Number(o.limit);
      if(!Number.isSafeInteger(cap)||cap<1||cap>3000)throw new Error("Invalid demo search page limit");
      let candidates=previous?.results;
      if(!candidates){
        let frames=demoFramesList(from,to).filter(f=>{
          if(monitor!==null&&f.monitor!==monitor||q&&!f.has_ocr)return false;
          const c=parseRecallContext(f.context), known=recallContextKnown(c);
          if(filters.context==="known"&&!known||filters.context==="unknown"&&known)return false;
          const app=c?.window.status==="observed" ? c.window.app : null;
          const title=c?.window.status==="observed" ? c.window.title : null;
          const host=c?.browser.status==="observed" ? c.browser.url_host : null;
          if(filters.app&&(!app||(filters.app_mode==="prefix" ? !asciiLower(app).startsWith(filters.app) : asciiLower(app)!==filters.app)))return false;
          if(filters.title&&(!title||!asciiLower(title).includes(asciiLower(filters.title))))return false;
          return !filters.url_host||host===filters.url_host;
        });
        if(sort==="newest")frames=frames.reverse();
        candidates=frames.map((f,i)=>({...f,rank:q ? 1/(i+1) : 0,snippet:q ? `…recognized on-screen text matching [[[${q}]]] in the captured screen…` : ""}));
      }
      const results=candidates.slice(offset,offset+cap), hasMore=offset+results.length<candidates.length;
      let next:string|null=null;
      if(hasMore){
        const key=match?.[1] ?? crypto.randomUUID();
        if(!previous){recallSearchPages.set(key,{device:String(_id),query:q,filters,scope:String(scope),sort:String(sort),monitor:monitor as number|null,from,to,results:candidates});while(recallSearchPages.size>16)recallSearchPages.delete(recallSearchPages.keys().next().value!);}
        next=`demo-search:${key}:${offset+results.length}`;
      }
      // scope and sort were validated against their allowed values above.
      return {query:q,from:scope==="retained" ? null : new Date(from).toISOString(),to:new Date(to).toISOString(),monitor:monitor as number|null,limit:cap,count:results.length,results,filters,complete:!hasMore,has_more:hasMore,next_cursor:next,scope:scope as "range" | "retained",sort:sort as "ranked" | "newest"};
    },
    // Demo has no real OCR geometry; return none so the overlay stays inert rather
    // than drawing selectable text that doesn't line up with the fake desktop.
    historyFrameText: async () => ({ text: null, words: [] }),
    historySegments: async (_id, day) => {
      const d = typeof day === "string" && day ? day : demoToday();
      return {
        day: d,
        timezone: demoTimezone(),
        count: demoSegments(d).length,
        segments: demoSegments(d),
      };
    },
    historyDaySummary: async (_id, day) => {
      const d = typeof day === "string" && day ? day : demoToday();
      const segs = demoSegments(d);
      const byCat: Record<string, number> = {};
      const byApp: Record<string, number> = {};
      let active = 0;
      for (const s of segs) {
        const secs = Math.round((new Date(s.end_ts).getTime() - new Date(s.start_ts).getTime()) / 1000);
        active += secs;
        byCat[s.category] = (byCat[s.category] ?? 0) + secs;
        if (s.app) byApp[s.app] = (byApp[s.app] ?? 0) + secs;
      }
      const topApps = Object.entries(byApp)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([app, seconds]) => ({ app, seconds }));
      return {
        day: d,
        timezone: demoTimezone(),
        summary: {
          day: d,
          narrative:
            "A focused day centred on Visual Studio Code — building out the Recall feature through the morning, with a midday stretch of research and a few Slack threads, then documentation into the afternoon. Attention held up well, with only short breaks.",
          totals: { active_seconds: active, segment_count: segs.length, by_category: byCat },
          top_apps: topApps,
          highlights: segs
            .slice()
            .sort(
              (a, b) =>
                new Date(b.end_ts).getTime() - new Date(b.start_ts).getTime() -
                (new Date(a.end_ts).getTime() - new Date(a.start_ts).getTime()),
            )
            .slice(0, 3)
            .map((s) => ({ label: s.summary ?? s.category, category: s.category, start_ts: s.start_ts, end_ts: s.end_ts })),
          source: "rule",
          updated_at: new Date().toISOString(),
        },
      };
    },
    historyActivity: async (_id, opts) => {
      const { from, to, buckets } = demoRange(opts);
      const n = buckets > 0 ? buckets : 120;
      const bs = Math.max(60, Math.floor(Math.max(60_000, to - from) / 1000 / n));
      const start = Math.floor(from / 1000 / bs) * bs;
      const points: { t: number; count: number }[] = [];
      for (let t = start; t * 1000 < to; t += bs) {
        const d = new Date(t * 1000);
        const hr = d.getHours() + d.getMinutes() / 60;
        // Diurnal curve: awake/working roughly 6:00–20:00, peak early afternoon.
        const day = Math.max(0, Math.sin(((hr - 6) / 14) * Math.PI));
        const ebb = (Math.sin(t / (bs * 6)) + 1) / 2; // natural ebb and flow within the day
        const count = Math.round(day * (0.45 + 0.55 * ebb) * 8);
        if (count > 0) points.push({ t, count });
      }
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        bucket_secs: bs,
        points,
      };
    },
    // Coverage for the date picker's heatmap: a run of recent days, thinning out
    // further back so the calendar looks like a real capture history rather than a
    // solid block.
    historyDays: async (_id, opts) => {
      const { from, to } = demoRange(opts);
      const days: {
        day: string;
        frame_count: number;
        first_ts: string | null;
        last_ts: string | null;
        has_summary: boolean;
      }[] = [];
      for (let t = to; t >= from; t -= 24 * 3600 * 1000) {
        const d = new Date(t);
        const age = Math.round((to - t) / (24 * 3600 * 1000));
        // Weekends quiet, and nothing at all beyond ~5 weeks of retention.
        const dow = d.getDay();
        if (age > 35) continue;
        const busy = dow === 0 || dow === 6 ? 0.25 : 1;
        const count = Math.round((420 - age * 6) * busy);
        if (count <= 0) continue;
        const iso = d.toLocaleDateString("en-CA");
        days.push({
          day: iso,
          frame_count: count,
          first_ts: new Date(`${iso}T08:12:00`).toISOString(),
          last_ts: new Date(`${iso}T18:40:00`).toISOString(),
          has_summary: age <= 14,
        });
      }
      days.reverse();
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        timezone: demoTimezone(),
        count: days.length,
        days,
      };
    },
    // One display: the demo desktop is a single fabricated screen, and offering a
    // picker for monitors that don't exist would be a worse lie than omitting it.
    historyMonitors: async (_id, opts) => {
      const { from, to } = demoRange(opts);
      return {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        monitors: [{ monitor: 0, frame_count: 1840, w: 1600, h: 900 }],
      };
    },
    recallSettingsGet: async () => demoRecallSettings,
    recallSettingsPut: async (patch) => ({
      ...demoRecallSettings,
      ...(patch as Record<string, unknown>),
    }),
    agentRecallSettingsGet: async () => ({
      effective: demoRecallSettings,
      override: null,
      global: demoRecallSettings,
    }),
    agentRecallSettingsPut: async () => ({
      effective: demoRecallSettings,
      override: null,
      global: demoRecallSettings,
    }),
    agentRecallSettingsDelete: async () => ({ ok: true }),
    // Synchronous string-returning method (unlike the async data methods above).
    // The `width` argument is ignored: demo frames are generated data URIs, so
    // there is nothing to downscale.
    historyBlobUrl: (_id, frameId) => demoFrameDataUri(frameId),
  };
}
