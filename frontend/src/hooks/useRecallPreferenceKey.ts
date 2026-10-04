import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { fleetServerScope } from "../lib/fleetPreferences";
import { preferenceKey } from "../components/recall/recallRetrieval";
function subscribe(callback:()=>void) {
  window.addEventListener("storage",callback);window.addEventListener("focus",callback);
  return ()=>{window.removeEventListener("storage",callback);window.removeEventListener("focus",callback);};
}
/** Never reuse browser-local Recall searches across unverified account/server scopes. */
export function useRecallPreferenceKey(agentId:string|null) {
  const server=useSyncExternalStore(subscribe,fleetServerScope,()=>"");
  const generation=useRef(0);
  const [identity,setIdentity]=useState<{server:string;user:string}|null>(null);
  useEffect(()=>{
    let alive=true;
    let pending:AbortController|null=null;
    const verify=()=>{
      if(pending)return;
      const request=++generation.current;setIdentity(null);
      if(typeof api.me!=="function")return;
      const controller=new AbortController();pending=controller;
      void api.me(controller.signal).then(user=>{if(alive&&request===generation.current&&fleetServerScope()===server&&typeof user.id==="string"&&user.id)setIdentity({server,user:user.id});}).catch(()=>{}).finally(()=>{if(pending===controller)pending=null;});
    };
    const expire=()=>{++generation.current;pending?.abort();pending=null;setIdentity(null);};
    verify();window.addEventListener("focus",verify);window.addEventListener("vantyr-session-expired",expire);
    // Cancels promises rather than referencing a DOM node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return ()=>{alive=false;++generation.current;pending?.abort();pending=null;window.removeEventListener("focus",verify);window.removeEventListener("vantyr-session-expired",expire);};
  },[server]);
  return agentId&&identity?.server===server ? preferenceKey(identity.user,agentId) : null;
}
