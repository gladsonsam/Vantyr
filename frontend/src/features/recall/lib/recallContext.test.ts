import { expect, it } from "vitest";
import { EMPTY_CONTEXT_FILTERS, normalizeRecallHost, parseRecallContext, parseRecallFilters, recallContextKnown, recallContextSignature } from "./recallContext";
import { observedContext as observed } from "@/features/recall/__fixtures__/context";
import { parseRecallSearchParams, recallPageHref, writeRecallSearchParams } from "./recallUrl";
import { parseSavedSearch, preferenceKey, readItems, writeItems } from "./recallRetrieval";

it("keeps missing legacy context distinct from observed, unknown and uncertain components",()=>{
  expect(parseRecallContext(undefined)).toBeNull();expect(parseRecallContext(null)).toBeNull();expect(parseRecallContext({...observed,version:2})).toBeNull();
  expect(parseRecallContext(observed)).toEqual(observed);expect(recallContextKnown(observed)).toBe(true);
  const uncertain={...observed,window:{status:"uncertain",reason:"changed",source:"none",app:null,title:null}};
  expect(parseRecallContext(uncertain)?.window.status).toBe("uncertain");expect(recallContextKnown(uncertain)).toBe(false);
  expect(parseRecallContext({...uncertain,window:{...uncertain.window,app:"unverified.exe"}})?.window).toMatchObject({status:"unknown",reason:"invalid_context",app:null});
});
it("bounds metadata and discards invalid components and reserved URLs without exposing ingestion revisions",()=>{
  expect(parseRecallContext({...observed,bracket_ms:1001})).toBeNull();expect(parseRecallContext({...observed,extra:"x".repeat(4096)})).toBeNull();
  const invalid={...observed,window:{...observed.window,app:"😀".repeat(65)},browser:{status:"observed",reason:null,source:"uia_hwnd",url:"https://secret.example/path",url_host:"secret.example"},grant_revisions:{window_activity:"18446744073709551615"}};
  const parsed=parseRecallContext(invalid)!;expect(parsed.window.app).toBeNull();expect(parsed.browser.url_host).toBeNull();expect(parsed).not.toHaveProperty("grant_revisions");
  expect(parseRecallContext({...observed,window:{...observed.window,title:"bad\u0000title"}})?.window.status).toBe("unknown");
});
it.each([["ExAmPlE.com.","example.com"],["münich.example","xn--mnich-kva.example"],["localhost","localhost"],["127.1","127.0.0.1"],["[2001:db8::1]","2001:db8::1"],["2001:db8:0::1","2001:db8::1"]])("normalizes exact host %s",(value,expected)=>expect(normalizeRecallHost(value)).toBe(expected));
it.each(["https://example.com","example.com/path","example.com:443","[::1]:443","example.com?x","user@example.com","bad host","%65xample.com","-bad.example","example.com.."])("rejects non-host filter %s",value=>expect(()=>normalizeRecallHost(value)).toThrow());
it("normalizes only ASCII app case, preserves literal wildcard/title text, and rejects overlong/control/conflicting filters",()=>{
  expect(parseRecallFilters({app:" Editor_%\\.EXE ",app_mode:"prefix",title:"你好 %_",context:"known"})).toEqual({...EMPTY_CONTEXT_FILTERS,app:"editor_%\\.exe",app_mode:"prefix",title:"你好 %_",context:"known"});
  expect(parseRecallFilters({app:"ÉDITOR.EXE"}).app).toBe("Éditor.exe");
  for(const raw of [{app:"😀".repeat(65)},{title:"😀".repeat(257)},{app:"a\n"},{app_mode:"prefix"},{context:"unknown",app:"editor.exe"},{context:"unknown",title:"text"},{context:"bogus"},{unknown:"field"}])expect(()=>parseRecallFilters(raw)).toThrow();
});
it("roundtrips bounded context-only and OCR searches through URL state without changing ordinary moment links",()=>{
  const search={query:"",scope:"range" as const,sort:"newest" as const,monitor:null,from:"2026-10-03T00:00:00Z",to:"2026-10-04T00:00:00Z",filters:parseRecallFilters({app:"Editor.EXE",title:"<img src=x onerror=alert(1)>",url_host:"docs.example.com"})};
  const url=new URL(recallPageHref("device",{at:"2026-10-03T01:00:00Z",monitor:1,search}),"https://example.test");
  expect(parseRecallSearchParams(url.searchParams)).toEqual({search,error:null});expect(url.searchParams.get("search_monitor")).toBe("all");
  writeRecallSearchParams(url.searchParams,null);expect(parseRecallSearchParams(url.searchParams)).toEqual({search:null,error:null});expect(url.searchParams.get("monitor")).toBe("1");
  const old=new URLSearchParams("q=needle");expect(parseRecallSearchParams(old).search).toMatchObject({query:"needle",sort:"ranked",scope:"retained",filters:EMPTY_CONTEXT_FILTERS});
  for(const value of ["q=&context=all","q=&context=unknown&app=editor.exe","q=needle&app_mode=prefix","q=needle&title="+"😀".repeat(257)])expect(parseRecallSearchParams(new URLSearchParams(value))).toMatchObject({search:null,error:expect.any(String)});
});
it("restores old saved searches as OCR/all-context and validates new scoped saved filters",()=>{
  localStorage.clear();const legacy={query:"needle",scope:"retained",sort:"ranked",monitor:0};
  expect(parseSavedSearch(legacy)).toEqual({...legacy,filters:EMPTY_CONTEXT_FILTERS});
  const search=parseSavedSearch({...legacy,query:"",sort:"newest",filters:{context:"unknown"}})!;expect(search.filters?.context).toBe("unknown");
  expect(parseSavedSearch({...legacy,query:""})).toBeNull();expect(parseSavedSearch({...legacy,filters:{app:"x".repeat(257)}})).toBeNull();
  const key=preferenceKey("user-a","device-a");writeItems(key,[search]);expect(readItems(key).map(parseSavedSearch)).toEqual([search]);
  expect(readItems(preferenceKey("user-b","device-a"))).toEqual([]);expect(readItems(preferenceKey("user-a","device-b"))).toEqual([]);
  localStorage.setItem("vantyr-server-settings",JSON.stringify({serverOrigin:"https://other.example"}));expect(readItems(preferenceKey("user-a","device-a"))).toEqual([]);localStorage.clear();
});
it("context grouping signatures preserve differing values and uncertainty while ignoring bracket timing",()=>{
  expect(recallContextSignature(observed)).toBe(recallContextSignature({...observed,bracket_ms:80}));
  expect(recallContextSignature(observed)).not.toBe(recallContextSignature({...observed,window:{...observed.window,title:"Other title"}}));
});

it("rejects coerced enum arrays in saved filters and response context",()=>{
  expect(()=>parseRecallFilters({context:["known"]})).toThrow();
  expect(parseRecallContext({...observed,monitor_relation:["same"]})).toBeNull();
  expect(parseRecallContext({...observed,window:{...observed.window,status:["observed"],app:null,title:null}})?.window.status).toBe("unknown");
  expect(parseRecallContext({...observed,window:{...observed.window,source:["win32"]}})?.window.status).toBe("unknown");
});
