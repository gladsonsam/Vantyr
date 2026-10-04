import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import recallStyles from "./recall.css?raw";
import { RecallCaptureContext } from "./RecallCaptureContext";
import { RecallPlayer } from "./RecallPlayer";
import { observedContext } from "./__fixtures__/context";
import { vi } from "vitest";
vi.mock("../../lib/api",()=>({api:{historyBlobUrl:(_device:string,id:number)=>`/capture/${id}`,historyFrameText:vi.fn().mockResolvedValue({words:[]})}}));
vi.mock("./RecallFilmstrip",()=>({RecallFilmstrip:()=>null}));
vi.mock("./RecallScrubber",()=>({RecallScrubber:()=>null}));

it("renders legacy, unknown, not-collected and uncertain labels without candidate attribution or engineering terminology",()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div"),root=createRoot(host);
  try {
    act(()=>root.render(<RecallCaptureContext context={null}/>));expect(host.textContent).toContain("No context recorded (older or unavailable metadata)");
    act(()=>root.render(<RecallCaptureContext context={{...observedContext,window:{status:"uncertain",reason:"changed",source:"none",app:null,title:null}}}/>));
    expect(host.textContent).toContain("Uncertain (foreground changed during sampling)");expect(host.textContent).not.toContain("Editor.EXE");expect(host.textContent).toContain("Unknown (provider unsupported)");
    act(()=>root.render(<RecallCaptureContext context={{...observedContext,window:{status:"not_collected",reason:"module_disabled",source:"none",app:null,title:null}}}/>));expect(host.textContent).toContain("Not collected (local module disabled)");
    expect(host.textContent).not.toContain("atomic");expect(host.textContent).not.toContain("schema");expect(host.textContent).not.toContain("win32");expect(host.querySelector("details")!.open).toBe(false);
  } finally {act(()=>root.unmount());}
});
it("wraps long literal titles in a 320px container with a 44px explanation control using actual styles",()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div"),root=createRoot(host),style=document.createElement("style");
  style.textContent=recallStyles.slice(recallStyles.indexOf(".recall-context-filters > summary"));document.head.append(style);host.style.width="320px";document.body.append(host);
  const text="<img src=x onerror=alert(1)>"+"VeryLongUnbrokenTitle".repeat(30);
  try {
    act(()=>root.render(<RecallCaptureContext context={{...observedContext,window:{...observedContext.window,title:text}}}/>));
    expect(host.textContent).toContain(text);expect(host.querySelector("img")).toBeNull();expect(host.querySelector("script")).toBeNull();
    expect(getComputedStyle(host.querySelector(".recall-capture-context")!).overflowWrap).toBe("anywhere");expect(getComputedStyle(host.querySelector("summary")!).minHeight).toBe("44px");
  } finally {act(()=>root.unmount());host.remove();style.remove();}
});
it("shows the selected frame's context only after its pixels load, clearing it across seek/image failures",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div"),root=createRoot(host);document.body.append(host);
  const frames=[{id:1,captured_at:"2026-10-03T00:00:00Z",monitor:1,w:1080,h:1920,phash:"1",has_ocr:false,context:observedContext},{id:2,captured_at:"2026-10-03T00:01:00Z",monitor:1,w:1080,h:1920,phash:"2",has_ocr:false,context:{...observedContext,window:{...observedContext.window,app:"Second.EXE",title:"Second capture"}}}];
  const render=(at:string)=>act(()=>root.render(<RecallPlayer agentId="device" frames={frames} fromMs={Date.parse(frames[0].captured_at)} toMs={Date.parse(frames[1].captured_at)} playheadMs={Date.parse(at)} onSeek={vi.fn()} loading={false} activity={null} timezone="UTC" monitors={[]} monitor={1} onMonitorChange={vi.fn()}/>));
  try {
    render(frames[0].captured_at);expect(host.querySelector(".recall-player-context")).toBeNull();act(()=>host.querySelector("img")!.dispatchEvent(new Event("load")));expect(host.textContent).toContain("Editor.EXE");
    render(frames[1].captured_at);expect(host.querySelector(".recall-player-context")).toBeNull();act(()=>host.querySelector("img")!.dispatchEvent(new Event("load")));expect(host.textContent).toContain("Second.EXE");expect(host.textContent).not.toContain("Editor.EXE");
    act(()=>host.querySelector("img")!.dispatchEvent(new Event("error")));expect(host.textContent).not.toContain("Second.EXE");
  } finally {await act(async()=>root.unmount());host.remove();}
});

it("selects the clicked frame ID and its context when two frames share a capture timestamp",async()=>{
  Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});const host=document.createElement("div"),root=createRoot(host);
  const at="2026-10-03T00:00:00Z",ms=Date.parse(at);
  const frames=[1,2].map(id=>({id,captured_at:at,monitor:1,w:1080,h:1920,phash:String(id),has_ocr:false,context:{...observedContext,window:{...observedContext.window,app:`Capture${id}.EXE`}}}));
  try {
    await act(async()=>root.render(<RecallPlayer agentId="device" frames={frames} fromMs={ms} toMs={ms+60000} playheadMs={ms} selectedFrameId={1} onSeek={vi.fn()} loading={false} activity={null} timezone="UTC" monitors={[]} monitor={1} onMonitorChange={vi.fn()}/>));
    expect(host.querySelector("img")!.getAttribute("src")).toBe("/capture/1");
    act(()=>host.querySelector("img")!.dispatchEvent(new Event("load")));
    expect(host.textContent).toContain("Capture1.EXE");expect(host.textContent).not.toContain("Capture2.EXE");
  } finally {await act(async()=>root.unmount());}
});
