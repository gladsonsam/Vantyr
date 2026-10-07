import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/api";
import type { ScreenFrame } from "@/api/types";
import { recallPageHref } from "@/lib/recallUrl";
import { deviceTime, readItems, writeItems, type Bookmark, type SavedSearch } from "./recallRetrieval";
import { shortDateIn, timeIn } from "./recallFormat";

export function RecallNavigation({ agentId, timezone, atMs, monitor, displayedFrame, preferencesKey, search, onSeek, onRange, onMonitor }: {
  agentId: string; timezone: string | null; atMs: number; monitor: number | null; displayedFrame: Pick<ScreenFrame, "id" | "captured_at" | "monitor"> | null; preferencesKey: string | null; search?:SavedSearch|null;
  onSeek: (iso: string) => void; onRange: (range: { fromMs: number; toMs: number }) => void; onMonitor: (monitor: number | null) => void;
}) {
  const [jump, setJump] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [message, setMessage] = useState("");
  const [link, setLink] = useState("");
  const [note, setNote] = useState("");
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const generation = useRef(0);
  useEffect(() => {
    setBookmarks(preferencesKey ? readItems<Bookmark>(`${preferencesKey}:bookmarks`).filter(b => b != null && typeof b.id === "string" && typeof b.note === "string" && Number.isFinite(Date.parse(b.at)) && Number.isSafeInteger(b.frameId) && (b.monitor == null || Number.isSafeInteger(b.monitor))) : []);
    setLink(""); setMessage(""); setNote("");
    generation.current++;
    // This counter cancels asynchronous requests, rather than referencing a DOM node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { generation.current++; };
  }, [preferencesKey, agentId]);
  const persist = (next: Bookmark[]) => {
    if (!preferencesKey || !writeItems(`${preferencesKey}:bookmarks`, next)) { setMessage("Browser storage is unavailable; changes were not saved."); return; }
    setBookmarks(next);
  };
  const copy = async () => {
    const token = generation.current;
    // A frame can precede the playhead or belong to one display in an all-display view.
    // Copy its exact recording coordinates whenever a frame is displayed.
    const url = new URL(recallPageHref(agentId, {
      at: displayedFrame?.captured_at ?? new Date(atMs).toISOString(),
      monitor: displayedFrame?.monitor ?? monitor,
      search,
    }), location.origin).href;
    try { await navigator.clipboard.writeText(url); if (token === generation.current) { setLink(""); setMessage("Moment link copied."); } }
    catch { if (token === generation.current) { setLink(url); setMessage("Clipboard unavailable. Select and copy the link below."); } }
  };
  const open = async (bookmark: Bookmark) => {
    const token = ++generation.current;
    setMessage("Checking bookmarked recording…");
    try {
      const result = await api.historyFrameAt(agentId, bookmark.at, bookmark.monitor);
      if (token !== generation.current) return;
      if (!result.frame || result.frame.id !== bookmark.frameId) { setMessage("This bookmarked recording is missing or expired. The note is still saved locally; you can remove it below."); return; }
      onMonitor(bookmark.monitor); onSeek(bookmark.at); setMessage("");
    } catch { if (token === generation.current) setMessage("Could not check this recording. Try again when the server is available."); }
  };
  return <section className="recall-navigation rounded-xl bg-card p-5" aria-label="Recall navigation and local bookmarks">
    <p className="text-sm text-muted-foreground">Device timezone: {timezone ?? "unavailable"}. Saved searches, bookmarks and notes are stored only in this browser for this server, user and device. They are not shared or stored on the server. Retention can expire recordings.</p>
    {!preferencesKey && <p role="status" className="mt-2 text-sm text-muted-foreground">Local saving is unavailable until your signed-in user identity is loaded.</p>}
    <div className="recall-retrieval-fields">
      <Label>Jump to time <Input type="datetime-local" value={jump} onChange={e => setJump(e.target.value)} className="h-9" /></Label>
      <Button variant="outline" size="lg" disabled={!timezone} onClick={() => { const ms = deviceTime(jump, timezone); if (ms == null) setMessage("Enter a valid device time. Ambiguous or skipped DST times are invalid."); else { generation.current++; onSeek(new Date(ms).toISOString()); setMessage(""); } }}>Jump</Button>
      <Button variant="outline" size="lg" onClick={() => void copy()}>Copy link to current moment</Button>
    </div>
    <div className="recall-retrieval-fields">
      <Label>Range from <Input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} className="h-9" /></Label>
      <Label>Range to <Input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} className="h-9" /></Label>
      <Button variant="outline" size="lg" disabled={!timezone} onClick={() => { const start = deviceTime(from, timezone), end = deviceTime(to, timezone); if (start == null || end == null || start >= end) setMessage("Enter a valid start and later end in the device timezone. Ambiguous or skipped DST times are invalid."); else { generation.current++; onRange({ fromMs: start, toMs: end }); setMessage(""); } }}>Load custom range</Button>
    </div>
    <div className="recall-retrieval-fields">
      <Label>Bookmark note <Input value={note} maxLength={2000} onChange={e => setNote(e.target.value)} className="h-9" /></Label>
      <Button variant="outline" size="lg" disabled={!preferencesKey || !displayedFrame} onClick={() => { if (!displayedFrame) return; const { id: frameId, captured_at: at, monitor: frameMonitor } = displayedFrame; const id = `${frameId}:${frameMonitor}`; persist([{ id, at, frameId, monitor: frameMonitor, note }, ...bookmarks.filter(b => b.id !== id)].slice(0, 100)); }}>Bookmark current moment</Button>
    </div>
    {bookmarks.map(b => <div className="recall-retrieval-fields" key={b.id}>
      <Button variant="outline" size="lg" onClick={() => void open(b)}>{shortDateIn(timezone, Date.parse(b.at))} · {timeIn(timezone, b.at)} · {b.monitor == null ? "All displays" : `Display ${b.monitor + 1}`}</Button>
      <Label>Saved note <Input value={b.note} maxLength={2000} onChange={e => persist(bookmarks.map(item => item.id === b.id ? { ...item, note: e.target.value } : item))} className="h-9" /></Label>
      <Button variant="ghost" size="lg" onClick={() => { generation.current++; persist(bookmarks.filter(item => item.id !== b.id)); }}>Remove bookmark</Button>
    </div>)}
    {message && <p role="status" className="mt-2 text-sm text-muted-foreground">{message}</p>}
    {link && <Label>Moment link <Input className="recall-copy-link h-9" readOnly value={link} onFocus={e => e.target.select()} /></Label>}
  </section>;
}
