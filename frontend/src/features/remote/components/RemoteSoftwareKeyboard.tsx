import { useImperativeHandle, useRef, useState, type Ref } from "react";
export interface RemoteKeyboardHandle { cancel: () => void }
/** Draft locally: IME/input events never send; explicit submission commits once. */
export function RemoteSoftwareKeyboard({ enabled, onText, ref }: { enabled: boolean; onText: (text: string) => boolean; ref: Ref<RemoteKeyboardHandle> }) {
  const [draft, setDraft] = useState("");
  const [composing, setComposing] = useState(false);
  const value = useRef("");
  const composition = useRef(false);
  const cancelledComposition = useRef(false);
  const cancel = () => { if (composition.current) cancelledComposition.current = true; value.current = ""; composition.current = false; setDraft(""); setComposing(false); };
  useImperativeHandle(ref, () => ({ cancel }));
  return <div className="remote-software-keyboard">
    <label>Remote text <textarea aria-label="Remote text" disabled={!enabled} value={draft} rows={2} maxLength={16000} autoCorrect="off" autoCapitalize="off" spellCheck={false}
      onFocus={() => { cancelledComposition.current = false; }}
      onChange={event => { if (!enabled || cancelledComposition.current) return; value.current = event.target.value; setDraft(event.target.value); }}
      onCompositionStart={() => { if (!enabled) return; cancelledComposition.current = false; composition.current = true; setComposing(true); }}
      onCompositionEnd={event => { if (!enabled || !composition.current) return; value.current = event.currentTarget.value; setDraft(value.current); composition.current = false; setComposing(false); }}
      onBlur={() => { if (composition.current) cancel(); }} /></label>
    <button type="button" disabled={!enabled || composing || !draft} onClick={() => { if (!enabled || composition.current || !value.current) return; if (onText(value.current)) cancel(); }}>Send text</button>
    <span>Up to 8,000 characters.</span>
  </div>;
}
