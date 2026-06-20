/**
 * Fake "live desktop" for demo mode.
 *
 * The real live screen is an MJPEG stream from the agent — there's no backend in
 * demo mode, so it would otherwise sit on "Connecting to live desktop…". This
 * renders a believable, lightly-animated desktop per agent (driven by the same
 * `demoLiveStatus` app/window the rest of the demo uses) so the screen panel —
 * and any promo footage recorded from it — looks alive.
 */
import { useMemo } from "react";
import { demoLiveStatus } from "./data";

type Scene = "terminal" | "code" | "design" | "email" | "browser";

function sceneFor(agentId: string): { scene: Scene; title: string } {
  const s = demoLiveStatus[agentId];
  const app = (s?.app ?? "").toLowerCase();
  const win = s?.window ?? "Desktop";
  if (app.includes("terminal") || /ssh|build|pipeline|powershell/i.test(win)) return { scene: "terminal", title: win };
  if (app.includes("code")) return { scene: "code", title: win };
  if (app.includes("figma")) return { scene: "design", title: win };
  if (app.includes("outlook")) return { scene: "email", title: win };
  return { scene: "browser", title: win };
}

const KEYFRAMES = `
@keyframes vfs-caret { 0%,49%{opacity:1} 50%,100%{opacity:0} }
@keyframes vfs-scan { 0%{transform:translateY(0)} 100%{transform:translateY(-50%)} }
@keyframes vfs-prog { 0%{width:8%} 100%{width:92%} }
@keyframes vfs-pulse { 0%,100%{opacity:.35} 50%{opacity:.8} }
`;

const C = {
  bg: "#08090b",
  win: "#16181d",
  bar: "#1d2026",
  line: "rgba(255,255,255,0.08)",
  tx: "#e7e9ee",
  dim: "rgba(231,233,238,0.55)",
  gr: "#20dd8f",
  blue: "#5aa9ff",
  amber: "#e8a93d",
  red: "#f0584c",
  purple: "#b98cff",
};

function Wallpaper() {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: `radial-gradient(ellipse 70% 60% at 50% 35%, #10141a, ${C.bg})`,
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "26px 26px",
        }}
      />
      {/* faint Vantyr bracket watermark */}
      <svg
        viewBox="0 0 20 20"
        style={{ position: "absolute", left: "50%", top: "42%", width: 220, height: 220, transform: "translate(-50%,-50%)", opacity: 0.05 }}
      >
        <path d="M2 2h5.5v2.6H4.6V8H2V2z" fill={C.gr} />
        <path d="M18 2h-5.5v2.6h2.9V8H18V2z" fill={C.gr} />
        <path d="M18 18h-5.5v-2.6h2.9V12H18v6z" fill={C.gr} />
        <circle cx="10" cy="10" r="1.6" fill={C.gr} />
      </svg>
    </div>
  );
}

function WindowFrame({ title, accent, children }: { title: string; accent: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        position: "absolute",
        left: "6%",
        top: "8%",
        width: "78%",
        height: "74%",
        background: C.win,
        borderRadius: 10,
        border: `1px solid ${C.line}`,
        boxShadow: "0 30px 80px rgba(0,0,0,0.55)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ height: 34, background: C.bar, borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", paddingLeft: 12, gap: 7 }}>
        {[C.red, C.amber, C.gr].map((c) => (
          <span key={c} style={{ width: 10, height: 10, borderRadius: "50%", background: c, opacity: 0.85 }} />
        ))}
        <span style={{ marginLeft: 12, fontSize: 12.5, color: C.dim, fontFamily: "var(--mono, monospace)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {title}
        </span>
        <span style={{ marginLeft: "auto", marginRight: 12, width: 36, height: 4, borderRadius: 2, background: accent, opacity: 0.5 }} />
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>{children}</div>
    </div>
  );
}

function Taskbar() {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: 38,
        background: "rgba(10,12,15,0.85)",
        borderTop: `1px solid ${C.line}`,
        display: "flex",
        alignItems: "center",
        padding: "0 14px",
        gap: 10,
      }}
    >
      <svg viewBox="0 0 20 20" style={{ width: 16, height: 16 }}>
        <path d="M2 2h5.5v2.6H4.6V8H2V2z" fill={C.gr} />
        <path d="M18 2h-5.5v2.6h2.9V8H18V2z" fill={C.gr} />
        <path d="M18 18h-5.5v-2.6h2.9V12H18v6z" fill={C.gr} opacity=".45" />
        <circle cx="10" cy="10" r="1.6" fill={C.gr} />
      </svg>
      {[C.blue, C.amber, C.purple, C.gr].map((c, i) => (
        <span key={i} style={{ width: 18, height: 18, borderRadius: 5, background: c, opacity: 0.7 }} />
      ))}
      <span style={{ marginLeft: "auto", fontSize: 12, color: C.dim, fontFamily: "var(--mono, monospace)" }}>
        {new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
      </span>
    </div>
  );
}

function TerminalScene() {
  const lines = [
    ["$ cargo build --release", C.tx],
    ["   Compiling vantyr-agent v0.2.9", C.dim],
    ["   Compiling tokio v1.39.2", C.dim],
    ["   Compiling serde v1.0.210", C.dim],
    ["   Compiling axum v0.7.6", C.dim],
    ["warning: unused import: `std::fmt`", C.amber],
    ["    Finished release [optimized] in 1m 58s", C.gr],
    ["$ ./target/release/vantyr-agent --enroll", C.tx],
    ["[info] connecting to wss://demo.vantyr.local", C.dim],
    ["[info] telemetry batch uploaded (24 events)", C.gr],
    ["[info] screen capture ready", C.gr],
    ["$ git push origin build/pipeline-2291", C.tx],
  ];
  return (
    <div style={{ position: "absolute", inset: 0, background: "#0c0e12", padding: 16, fontFamily: "var(--mono, monospace)", fontSize: 14, lineHeight: 1.7, overflow: "hidden" }}>
      <div style={{ animation: "vfs-scan 26s linear infinite" }}>
        {[...lines, ...lines].map((l, i) => (
          <div key={i} style={{ color: l[1] as string }}>{l[0]}</div>
        ))}
      </div>
      <span style={{ display: "inline-block", width: 9, height: 17, background: C.gr, verticalAlign: "middle", animation: "vfs-caret 1.05s step-end infinite" }} />
    </div>
  );
}

function CodeScene() {
  const code: Array<Array<[string, string]>> = [
    [["pub async fn ", C.blue], ["run_agent_loop", C.gr], ["(cfg: Config) {", C.tx]],
    [["    let mut ", C.blue], ["stream", C.tx], [" = ", C.tx], ["connect", C.gr], ["(&cfg).", C.tx], ["await", C.purple], ["?;", C.tx]],
    [["    ", C.tx], ["loop", C.purple], [" {", C.tx]],
    [["        let frame = capture_screen()", C.tx]],
    [["            .", C.tx], ["encode_jpeg", C.gr], ["(quality);", C.tx]],
    [["        stream.", C.tx], ["send", C.gr], ["(frame).", C.tx], ["await", C.purple], ["?;", C.tx]],
    [["        telemetry.", C.tx], ["flush", C.gr], ["().", C.tx], ["await", C.purple], [";", C.tx]],
    [["    }", C.tx]],
    [["}", C.tx]],
  ];
  return (
    <div style={{ position: "absolute", inset: 0, background: "#0e1014", display: "flex", fontFamily: "var(--mono, monospace)", fontSize: 14, lineHeight: 1.85 }}>
      <div style={{ width: 44, background: "#0b0d11", color: "rgba(255,255,255,0.25)", textAlign: "right", padding: "14px 8px", userSelect: "none" }}>
        {code.map((_, i) => <div key={i}>{i + 1}</div>)}
      </div>
      <div style={{ padding: "14px 16px", flex: 1 }}>
        {code.map((row, i) => (
          <div key={i}>
            {row.map((seg, j) => <span key={j} style={{ color: seg[1] }}>{seg[0]}</span>)}
            {i === code.length - 4 && (
              <span style={{ display: "inline-block", width: 8, height: 16, background: C.tx, verticalAlign: "middle", marginLeft: 1, animation: "vfs-caret 1.05s step-end infinite" }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function DesignScene() {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#15171c", display: "flex" }}>
      <div style={{ width: 150, borderRight: `1px solid ${C.line}`, padding: 12 }}>
        {["Frame · Dashboard", "Sidebar", "Agent card", "Vitals", "Tabs", "Timeline"].map((t, i) => (
          <div key={i} style={{ fontSize: 12.5, color: i === 2 ? C.gr : C.dim, padding: "6px 8px", borderRadius: 6, background: i === 2 ? "rgba(32,221,143,0.1)" : "transparent", marginBottom: 2, fontFamily: "var(--font, sans-serif)" }}>
            {t}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, position: "relative", background: "#0e1014", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: "62%", height: "64%", background: C.win, borderRadius: 10, border: `2px solid ${C.gr}`, boxShadow: `0 0 40px rgba(32,221,143,0.25)`, padding: 14, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gridAutoRows: "minmax(40px, auto)", gap: 10 }}>
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} style={{ borderRadius: 8, background: i % 4 === 0 ? "rgba(32,221,143,0.18)" : "rgba(255,255,255,0.05)", border: `1px solid ${C.line}`, animation: i % 3 === 0 ? "vfs-pulse 3s ease-in-out infinite" : "none" }} />
          ))}
        </div>
      </div>
      <div style={{ width: 130, borderLeft: `1px solid ${C.line}`, padding: 12 }}>
        {["Fill", "#20DD8F", "Radius 10", "Auto-layout", "Opacity 100%"].map((t, i) => (
          <div key={i} style={{ fontSize: 12, color: C.dim, marginBottom: 8, fontFamily: "var(--mono, monospace)" }}>{t}</div>
        ))}
      </div>
    </div>
  );
}

function EmailScene() {
  const rows = [
    ["Build #2291 succeeded", "ci@vantyr.local", true],
    ["Weekly fleet report", "reports@vantyr.local", false],
    ["3 agents need attention", "alerts@vantyr.local", false],
    ["Re: Rollout schedule", "ops@vantyr.local", false],
    ["New enrollment request", "noreply@vantyr.local", false],
  ];
  return (
    <div style={{ position: "absolute", inset: 0, background: "#101216", display: "flex", fontFamily: "var(--font, sans-serif)" }}>
      <div style={{ width: "42%", borderRight: `1px solid ${C.line}` }}>
        {rows.map((r, i) => (
          <div key={i} style={{ padding: "12px 16px", borderBottom: `1px solid ${C.line}`, background: i === 0 ? "rgba(32,221,143,0.07)" : "transparent" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {r[2] && <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.gr }} />}
              <span style={{ fontSize: 14, color: r[2] ? C.tx : C.dim, fontWeight: r[2] ? 600 : 400 }}>{r[0]}</span>
            </div>
            <div style={{ fontSize: 12, color: "rgba(231,233,238,0.4)", marginTop: 4 }}>{r[1] as string}</div>
          </div>
        ))}
      </div>
      <div style={{ flex: 1, padding: 20 }}>
        <div style={{ fontSize: 17, color: C.tx, fontWeight: 600 }}>Build #2291 succeeded</div>
        <div style={{ fontSize: 13, color: C.dim, marginTop: 6 }}>ci@vantyr.local · 2 min ago</div>
        <div style={{ marginTop: 16, height: 8, width: "90%", borderRadius: 4, background: "rgba(255,255,255,0.06)" }} />
        <div style={{ marginTop: 10, height: 8, width: "80%", borderRadius: 4, background: "rgba(255,255,255,0.06)" }} />
        <div style={{ marginTop: 10, height: 8, width: "86%", borderRadius: 4, background: "rgba(255,255,255,0.06)" }} />
      </div>
    </div>
  );
}

function BrowserScene() {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#0f1115", padding: 0 }}>
      <div style={{ height: 30, background: "#0b0d11", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", padding: "0 12px", gap: 8 }}>
        <span style={{ fontSize: 12, color: C.dim, fontFamily: "var(--mono, monospace)" }}>⌂  github.com/example/vantyr/pull/482</span>
      </div>
      <div style={{ padding: 22 }}>
        <div style={{ fontSize: 18, color: C.tx, fontWeight: 600, fontFamily: "var(--font, sans-serif)" }}>Cross-platform agent build · #482</div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          <span style={{ fontSize: 12, color: C.bg, background: C.gr, borderRadius: 999, padding: "3px 10px", fontWeight: 600 }}>● Open</span>
          <span style={{ fontSize: 12, color: C.dim }}>gladsonsam wants to merge 12 commits</span>
        </div>
        {[88, 72, 80, 64].map((w, i) => (
          <div key={i} style={{ marginTop: 12, height: 9, width: `${w}%`, borderRadius: 4, background: "rgba(255,255,255,0.06)" }} />
        ))}
      </div>
    </div>
  );
}

export function DemoScreen({ agentId }: { agentId: string }) {
  const { scene, title } = useMemo(() => sceneFor(agentId), [agentId]);
  const accent = scene === "terminal" ? C.gr : scene === "code" ? C.blue : scene === "design" ? C.purple : scene === "email" ? C.amber : C.gr;

  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <style>{KEYFRAMES}</style>
      <Wallpaper />
      <WindowFrame title={title} accent={accent}>
        {scene === "terminal" && <TerminalScene />}
        {scene === "code" && <CodeScene />}
        {scene === "design" && <DesignScene />}
        {scene === "email" && <EmailScene />}
        {scene === "browser" && <BrowserScene />}
      </WindowFrame>
      <Taskbar />
    </div>
  );
}
