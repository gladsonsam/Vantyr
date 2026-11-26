import { Lock, Server, Tags } from "lucide-react";
import { SettingsSection } from "@/features/network/components/SettingsSection";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import type { DnsView } from "@/features/network/runtime/types";
import { SettingRow } from "./SettingRow";

type Ready<K extends keyof DnsView> = Extract<DnsView[K], { state: "ready" }>["data"];

const MONO = "font-mono text-[0.8125rem]";
const NOT_REPORTED = <span className="text-sm text-muted-foreground">Not reported</span>;

function addresses(list: string[] | undefined) {
  if (!Array.isArray(list)) return NOT_REPORTED;
  if (list.length === 0) return <span className="text-sm text-muted-foreground">None</span>;
  return <span className={MONO}>{list.join(", ")}</span>;
}

const MODE: Record<Ready<"upstreams">["mode"], string> = {
  sequential: "One at a time, in order",
  parallel: "All at once, first answer wins",
  fastest: "Whichever answers fastest",
};

export function UpstreamsCard({ upstreams }: { upstreams: Ready<"upstreams"> }) {
  const servers = Array.isArray(upstreams.servers) ? upstreams.servers : [];
  return (
    <SettingsSection title="Upstream servers" icon={<Server />}>
      {servers.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">No upstream servers listed.</p>
      ) : (
        servers.map((server) => (
          <SettingRow key={server.address} label={server.address}>
            <span className="text-[0.8125rem] text-muted-foreground">
              {server.protocol.toUpperCase()} · {server.healthy ? "healthy" : "not answering"}
            </span>
          </SettingRow>
        ))
      )}
      <SettingRow
        label="Lookup order"
        help="How the servers are asked. Read-only: changing upstreams is not available on this server yet."
      >
        <span className="text-sm text-muted-foreground">
          {upstreams.mode ? MODE[upstreams.mode] : "Not reported"}
        </span>
      </SettingRow>
      <SettingRow
        label="Bootstrap servers"
        help="Plain DNS servers used once, to find the address of an encrypted upstream."
      >
        {addresses(upstreams.bootstrap)}
      </SettingRow>
      <SettingRow
        label="Fallback servers"
        help="Asked only when every upstream above is not answering."
      >
        {addresses(upstreams.fallback)}
      </SettingRow>
    </SettingsSection>
  );
}

export function RewritesCard({ rewrites }: { rewrites: Ready<"rewrites"> }) {
  return (
    <SettingsSection title="Local records" icon={<Tags />}>
      <p className="px-5 py-3 text-[0.8125rem] text-muted-foreground">
        Read-only. Adding or editing records is not available on this server yet.
      </p>
      {rewrites.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">No local records.</p>
      ) : (
        rewrites.map((record) => (
          <SettingRow key={record.id} label={record.name}>
            <span className={MONO}>
              <span className="text-muted-foreground">{record.kind}</span> {record.value}
            </span>
          </SettingRow>
        ))
      )}
    </SettingsSection>
  );
}

export function EncryptedCard({ encrypted }: { encrypted: Ready<"encrypted"> }) {
  return (
    <SettingsSection title="Encrypted DNS" icon={<Lock />}>
      {encrypted.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">No encrypted transports reported.</p>
      ) : (
        encrypted.map((entry) => (
          <SettingRow key={entry.transport} label={entry.transport.toUpperCase()}>
            <span className="text-[0.8125rem] text-muted-foreground">
              {entry.coverage}
              {entry.certificateExpiresAt ? (
                <>
                  {" · certificate expires "}
                  <TimeAgo iso={entry.certificateExpiresAt} />
                </>
              ) : null}
            </span>
          </SettingRow>
        ))
      )}
    </SettingsSection>
  );
}
