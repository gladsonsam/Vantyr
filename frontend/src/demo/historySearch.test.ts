import { expect, it } from "vitest";
import { api } from "../lib/api";
import { createDemoApi } from "./api";
import { recallContextKnown } from "../lib/recallContext";

it("keeps synthetic context-only results newest/rank-zero and never invents current-agent hosts",async()=>{
  const demo=createDemoApi(api);
  const opts={scope:"retained" as const,sort:"newest" as const};
  const known=await demo.historySearch("demo","",{...opts,context:"known"});
  expect(known.results.length).toBeGreaterThan(0);
  expect(known.results.every(f=>recallContextKnown(f.context)&&f.rank===0&&f.snippet==="")).toBe(true);
  expect(known.results.map(f=>f.captured_at)).toEqual(known.results.map(f=>f.captured_at).sort().reverse());
  const unknown=await demo.historySearch("demo","",{...opts,context:"unknown"});expect(unknown.results.length).toBeGreaterThan(0);expect(unknown.results.every(f=>!recallContextKnown(f.context))).toBe(true);
  const app=await demo.historySearch("demo","",{...opts,app:"editor",app_mode:"prefix"});expect(app.results.length).toBeGreaterThan(0);expect(app.results.every(f=>f.context?.window.app==="Editor.EXE")).toBe(true);
  const host=await demo.historySearch("demo","",{...opts,url_host:"example.com"});expect(host.results).toEqual([]);
  await expect(demo.historySearch("demo","",{...opts,context:"unknown",app:"editor.exe"})).rejects.toThrow();
  await expect(demo.historySearch("demo","",{scope:"retained"})).rejects.toThrow();
});

it("paginates every matching synthetic capture with frozen filters, bounds and display",async()=>{
  const demo=createDemoApi(api);
  const opts={scope:"range" as const,sort:"newest" as const,context:"known" as const,monitor:0,from:"2026-10-03T00:00:00Z",to:"2026-10-03T02:00:00Z",limit:5};
  const whole=await demo.historySearch("demo","",{...opts,limit:3000});
  expect(whole.results.length).toBeGreaterThan(8);
  let page=await demo.historySearch("demo","",opts);
  expect(page.complete).toBe(false);expect(page.has_more).toBe(true);expect(page.results).toHaveLength(5);
  const cursor=page.next_cursor!;
  for(const changed of [{app:"editor.exe"},{context:"unknown" as const},{context:"all" as const},{monitor:1},{sort:"ranked" as const},{to:"2026-10-03T03:00:00Z"}])await expect(demo.historySearch("demo","",{...opts,...changed,cursor})).rejects.toThrow();
  await expect(demo.historySearch("other","",{...opts,cursor})).rejects.toThrow();
  await expect(demo.historySearch("demo","different query",{...opts,cursor})).rejects.toThrow();
  const loaded=[...page.results];
  while(page.has_more){page=await demo.historySearch("demo","",{cursor:page.next_cursor!,limit:5});expect(page.filters).toEqual(whole.filters);loaded.push(...page.results);}
  expect(loaded).toEqual(whole.results);expect(new Set(loaded.map(f=>f.id)).size).toBe(loaded.length);expect(page.complete).toBe(true);expect(page.next_cursor).toBeNull();
  const hidden=await demo.historySearch("demo","",{...opts,monitor:1});expect(hidden.results).toEqual([]);expect(hidden.complete).toBe(true);
});
