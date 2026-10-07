import { useSyncExternalStore } from "react";
import { fleetServerScope, useVerifiedUser } from "@/lib/fleetPreferences";
import { preferenceKey } from "@/components/recall/recallRetrieval";
function subscribe(callback:()=>void) {
  window.addEventListener("storage",callback);window.addEventListener("focus",callback);
  return ()=>{window.removeEventListener("storage",callback);window.removeEventListener("focus",callback);};
}
/** Never reuse browser-local Recall searches across unverified account/server scopes. */
export function useRecallPreferenceKey(agentId:string|null) {
  const server=useSyncExternalStore(subscribe,fleetServerScope,()=>"");
  const user=useVerifiedUser(server);
  return agentId&&user ? preferenceKey(user,agentId) : null;
}
