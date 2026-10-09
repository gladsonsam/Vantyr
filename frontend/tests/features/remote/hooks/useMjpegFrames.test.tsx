import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MjpegDecodeLane, startMjpegStream, useMjpegFrames, type DecodedRemoteFrame } from "@/features/remote/hooks/useMjpegFrames";
import { concat, deferred, encode, frameGeometry, frameJpeg, framePart, settle } from "@/features/remote/hooks/mjpegTestFixtures";

function bitmap(width = 16, height = 24) { return {width,height,close:vi.fn()} as unknown as ImageBitmap; }
function connection() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({start:c => {controller=c;},cancel});
  const response = new Response(body,{headers:{"Content-Type":"multipart/x-mixed-replace; boundary=testframe"}});
  return {controller,cancel,response};
}

beforeEach(() => { (globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true; });
afterEach(() => vi.unstubAllGlobals());
describe("bounded actual-source MJPEG transport/decode", () => {
  it("authenticates fetch, drains coalesced chunks and keeps only the latest pending decode", async () => {
    const c = connection(), decode = vi.fn<() => Promise<ImageBitmap>>(), first = deferred<ImageBitmap>(), last = deferred<ImageBitmap>();
    decode.mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const present = vi.fn<(frame:DecodedRemoteFrame)=>void>(), stopped = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(c.response);
    const stream = startMjpegStream("https://server.example/api/agents/device/mjpeg?session=UUID", {lane:new MjpegDecodeLane(decode),present,stopped,fetcher});
    await settle(); expect(fetcher.mock.calls[0][1]).toMatchObject({credentials:"include",cache:"no-store",signal:expect.any(AbortSignal)});
    c.controller.enqueue(concat(...Array.from({length:100},(_,i)=>framePart(frameJpeg(frameGeometry(i+1)))))); await settle();
    expect(decode).toHaveBeenCalledTimes(1); expect(present).not.toHaveBeenCalled();
    const a=bitmap(); first.resolve(a); await settle(); expect(decode).toHaveBeenCalledTimes(2); expect(present.mock.calls[0][0].geometry?.geometry_revision).toBe(1); expect(a.close).toHaveBeenCalled();
    const b=bitmap(); last.resolve(b); await settle(); expect(present.mock.calls[1][0].geometry?.geometry_revision).toBe(100); expect(b.close).toHaveBeenCalled();
    stream.cancel(); await stream.done; expect(c.cancel).toHaveBeenCalledTimes(1); expect(stopped).toHaveBeenCalledWith(null);
    expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
  });
  it("serializes decode across device/stream replacement and closes obsolete completions", async () => {
    const old=connection(), fresh=connection(), first=deferred<ImageBitmap>(), second=deferred<ImageBitmap>();
    const decode=vi.fn<()=>Promise<ImageBitmap>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise), lane=new MjpegDecodeLane(decode);
    const oldPresent=vi.fn(), newPresent=vi.fn();
    const a=startMjpegStream("old-device",{lane,present:oldPresent,stopped:vi.fn(),fetcher:vi.fn<typeof fetch>().mockResolvedValue(old.response)});
    await settle(); old.controller.enqueue(framePart()); await settle(); a.cancel();
    const b=startMjpegStream("new-device",{lane,present:newPresent,stopped:vi.fn(),fetcher:vi.fn<typeof fetch>().mockResolvedValue(fresh.response)});
    await settle(); fresh.controller.enqueue(framePart(frameJpeg(frameGeometry(2)))); await settle(); expect(decode).toHaveBeenCalledTimes(1);
    const stale=bitmap(); first.resolve(stale); await settle(); expect(stale.close).toHaveBeenCalled(); expect(oldPresent).not.toHaveBeenCalled(); expect(decode).toHaveBeenCalledTimes(2);
    second.resolve(bitmap()); await settle(); expect(newPresent.mock.calls[0][0].geometry.geometry_revision).toBe(2);
    b.cancel(); await Promise.all([a.done,b.done]);
  });
  it("makes dimension mismatch, missing, malformed and null physical geometry explicit", async () => {
    const c=connection(), decode=vi.fn<()=>Promise<ImageBitmap>>().mockResolvedValue(bitmap(17,24)), present=vi.fn();
    const s=startMjpegStream("stream",{lane:new MjpegDecodeLane(decode),present,stopped:vi.fn(),fetcher:vi.fn<typeof fetch>().mockResolvedValue(c.response)});
    await settle(); c.controller.enqueue(framePart()); await settle(); expect(present.mock.calls[0][0].geometry).toBeNull();
    decode.mockResolvedValue(bitmap());
    for (const g of [null,{bad:true},{...frameGeometry(),desktop:null}]) { c.controller.enqueue(framePart(frameJpeg(g))); await settle(); }
    expect(present.mock.calls[1][0].geometry).toBeNull(); expect(present.mock.calls[2][0].geometry).toBeNull(); expect(present.mock.calls[3][0].geometry.desktop).toBeNull();
    s.cancel(); await s.done;
  });
  it("aborts a late fetch response and never attaches a reader or decode after cancellation", async () => {
    const response=deferred<Response>(), c=connection(), decode=vi.fn(), present=vi.fn();
    const s=startMjpegStream("late",{lane:new MjpegDecodeLane(decode),present,stopped:vi.fn(),fetcher:vi.fn<typeof fetch>().mockReturnValue(response.promise)});
    s.cancel(); response.resolve(c.response); await s.done; expect(c.cancel).toHaveBeenCalled(); expect(decode).not.toHaveBeenCalled(); expect(present).not.toHaveBeenCalled();
  });
  it("bounds and displays actionable JSON HTTP errors and clears on EOF or malformed input", async () => {
    for (const [body,status,message] of [[JSON.stringify({error:"Release control before changing monitor",code:"selection_locked"}),409,"Release control"],["x".repeat(9000),409,"Release control"],["{bad",401,"401"]] as const) {
      const stopped=vi.fn(); const s=startMjpegStream("error",{lane:new MjpegDecodeLane(),present:vi.fn(),stopped,fetcher:vi.fn<typeof fetch>().mockResolvedValue(new Response(body,{status}))});
      await s.done; expect(stopped.mock.calls[0][0].message).toContain(message);
    }
    const c=connection(), stopped=vi.fn(), decode=vi.fn<()=>Promise<ImageBitmap>>().mockResolvedValue(bitmap());
    const s=startMjpegStream("eof",{lane:new MjpegDecodeLane(decode),present:vi.fn(),stopped,fetcher:vi.fn<typeof fetch>().mockResolvedValue(c.response)});
    await settle(); c.controller.enqueue(framePart()); await settle(); c.controller.close(); await s.done; expect(stopped.mock.calls[0][0].message).toContain("ended");
    const bad=connection(), rejected=vi.fn(); const b=startMjpegStream("bad",{lane:new MjpegDecodeLane(),present:vi.fn(),stopped:rejected,fetcher:vi.fn<typeof fetch>().mockResolvedValue(bad.response)});
    await settle(); bad.controller.enqueue(encode("not multipart")); await b.done; expect(rejected).toHaveBeenCalled(); expect(bad.cancel).toHaveBeenCalled();
  });
  it("checks compression-bomb dimensions before invoking the decoder", async () => {
    const image=frameJpeg(null);
    for(let i=0;i<image.length-8;i++) if(image[i]===0xff&&image[i+1]===0xc0) {image[i+5]=0x80;image[i+6]=0;image[i+7]=0x80;image[i+8]=0;break;}
    const c=connection(), decode=vi.fn(), stopped=vi.fn();
    const s=startMjpegStream("huge",{lane:new MjpegDecodeLane(decode),present:vi.fn(),stopped,fetcher:vi.fn<typeof fetch>().mockResolvedValue(c.response)});
    await settle(); c.controller.enqueue(framePart(image)); await s.done; expect(decode).not.toHaveBeenCalled(); expect(stopped.mock.calls[0][0].message).toContain("size limit");
  });
});

describe("canvas/display identity atomicity", () => {
  let root:Root, host:HTMLDivElement, state:ReturnType<typeof useMjpegFrames>;
  const before=vi.fn(), stopped=vi.fn(), draw=vi.fn();
  function Harness({url,enabled=true}:{url:string;enabled?:boolean}) {
    const canvas=useRef<HTMLCanvasElement>(null); state=useMjpegFrames(url,enabled,canvas,{beforeDisplay:before,stopped}); return <canvas ref={canvas}/>;
  }
  beforeEach(()=>{host=document.createElement("div");document.body.append(host);root=createRoot(host);before.mockReset();stopped.mockReset();draw.mockReset();vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue({drawImage:draw} as unknown as CanvasRenderingContext2D);});
  afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();});
  it("exposes only committed pixels, then clears geometry/canvas on stream replacement",async()=>{
    const a=connection(),b=connection(), next=deferred<ImageBitmap>();
    const decode=vi.fn().mockResolvedValueOnce(bitmap()).mockReturnValueOnce(next.promise).mockResolvedValueOnce(bitmap());
    vi.stubGlobal("createImageBitmap",decode);vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(a.response).mockResolvedValueOnce(b.response));
    await act(async()=>root.render(<Harness url="first"/>));
    await act(async()=>{a.controller.enqueue(framePart());await settle();});expect(state.getDisplayed()?.geometry?.geometry_revision).toBe(1);expect(host.querySelector("canvas")?.style.display).toBe("block");
    await act(async()=>{a.controller.enqueue(framePart(frameJpeg(frameGeometry(2))));await settle();});expect(state.getDisplayed()?.geometry?.geometry_revision).toBe(1);
    const stale=bitmap();await act(async()=>root.render(<Harness url="second"/>));expect(state.getDisplayed()).toBeNull();expect(host.querySelector("canvas")?.width).toBe(1);expect(host.querySelector("canvas")?.style.display).toBe("none");
    await act(async()=>{b.controller.enqueue(framePart(frameJpeg(frameGeometry(3))));await settle();});expect(decode).toHaveBeenCalledTimes(2);
    draw.mockImplementation(()=>expect(state.getDisplayed()).toBeNull());
    await act(async()=>{next.resolve(stale);await settle();});expect(stale.close).toHaveBeenCalled();expect(state.getDisplayed()?.geometry?.geometry_revision).toBe(3);
    expect(before.mock.calls.some(call=>call[0]===null)).toBe(true);
    await act(async()=>root.render(<Harness url="second" enabled={false}/>));expect(state.getDisplayed()).toBeNull();expect(b.cancel).toHaveBeenCalled();
  });
});
