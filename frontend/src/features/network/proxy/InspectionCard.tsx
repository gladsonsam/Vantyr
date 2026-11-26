import { ScanEye } from "lucide-react";
import { SettingsCardBody, SettingsSection } from "@/features/network/components/SettingsSection";
import SlideCommit from "@/components/react-bits/SlideCommit";
import Stepper, { Step } from "@/components/react-bits/Stepper";
import { HelpTip } from "@/components/common/HelpTip";
import { CopyValue } from "@/components/common/CopyValue";
import { TimeAgo } from "@/features/network/components/TimeAgo";
import { useSetInspectionMutation } from "@/features/network/runtime/useRuntimeQueries";
import type { ProxyInspection, TrustState } from "@/features/network/runtime/types";

const STEP: Record<TrustState, number> = {
  not_enabled: 1,
  pending_trust: 2,
  trusted: 3,
  rotating: 2,
  retired: 1,
};

const SLIDER = {
  width: 300,
  trackColor: "var(--muted)",
  handleColor: "var(--primary)",
  successColor: "var(--success)",
  dangerColor: "var(--destructive)",
} as const;

/**
 * HTTPS inspection is an explicit, reversible opt-in, and turning it on is not the same as it working:
 * devices have to trust the new certificate authority first. The steps say where that stands, and the
 * last one is never claimed until devices report it.
 */
export function InspectionCard({ inspection }: { inspection: ProxyInspection }) {
  const toggle = useSetInspectionMutation();
  const step = STEP[inspection.trust];
  return (
    <SettingsSection
      title="HTTPS inspection"
      icon={<ScanEye />}
      action={
        <HelpTip label="About HTTPS inspection">
          Lets the proxy read encrypted web traffic so it can filter it. It needs every device to
          trust a certificate authority that only this server holds. Apps that pin their own
          certificates stop working, and the private key never leaves the server. The proxy and its
          inspection speak HTTP/1.1 only: HTTP/2 is rejected and WebSocket upgrades are refused. A
          device that opens an explicit CONNECT tunnel carries its own TLS unchanged, and that
          traffic is not inspected.
        </HelpTip>
      }
    >
      <SettingsCardBody>

        <Stepper
          step={step}
          showFooter={false}
          indicator="dots"
          disableStepIndicators
          theme="dark"
          accentColor="var(--primary)"
        >
          <Step
            title="Create the authority"
            description="A certificate authority unique to this server."
          >
            <div className="space-y-4 py-4 text-sm text-muted-foreground">
              <p>
                Inspection is off by default. Turning it on creates the authority. Nothing is
                inspected yet.
              </p>
              <SlideCommit
                {...SLIDER}
                label="Slide to turn on"
                doneLabel="Turned on"
                errorLabel="Couldn’t enable"
                onConfirm={() => toggle.mutateAsync(true)}
              />
            </div>
          </Step>
          <Step
            title="Devices trust it"
            description="Each device must install and trust the certificate."
          >
            <div className="space-y-4 py-4 text-sm">
              {inspection.caFingerprint ? (
                <div className="space-y-1">
                  <div className="text-muted-foreground">Public fingerprint (read-only)</div>
                  <CopyValue text={inspection.caFingerprint} label="Fingerprint" mono />
                  <div className="text-muted-foreground">
                    Valid until <TimeAgo iso={inspection.caNotAfter} />
                  </div>
                </div>
              ) : null}
              <p className="text-muted-foreground">
                <span className="font-medium text-foreground">Reported by devices:</span>{" "}
                {inspection.trustingDevices} of {inspection.totalDevices} say they trust it. This is
                what devices report, not something the server checked. Until they trust it,
                inspection is not working for them.
              </p>
              <SlideCommit
                {...SLIDER}
                label="Slide to turn off"
                doneLabel="Turned off"
                errorLabel="Couldn’t disable"
                onConfirm={() => toggle.mutateAsync(false)}
              />
            </div>
          </Step>
          <Step title="Inspecting" description="Devices that trust the authority are inspected.">
            <div className="space-y-4 py-4 text-sm text-muted-foreground">
              <p>Inspection applies to devices that report trusting the authority.</p>
              <SlideCommit
                {...SLIDER}
                label="Slide to turn off"
                doneLabel="Turned off"
                errorLabel="Couldn’t disable"
                onConfirm={() => toggle.mutateAsync(false)}
              />
            </div>
          </Step>
        </Stepper>

        <div className="space-y-2">
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            Inspection exceptions
            <HelpTip label="About inspection exceptions">
              An exception is one exact host and port that is not inspected, and it expires after at
              most 7 days. Adding or editing exceptions is not available on this server yet.
            </HelpTip>
          </h4>
          {inspection.exceptions.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {inspection.exceptions.map((exception) => (
                <li
                  key={exception.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                >
                  <span>
                    <span className="font-mono text-[0.8125rem]">{exception.host}</span>
                    <span className="text-muted-foreground"> — {exception.scopeLabel}</span>
                  </span>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    expires <TimeAgo iso={exception.expiresAt} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {inspection.pinnedApps.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Apps you listed as not inspectable</h4>
            <ul className="divide-y divide-border/50">
              {inspection.pinnedApps.map((app) => (
                <li key={app.id} className="py-2.5 text-sm">
                  <span className="font-medium">{app.name}</span>
                  <span className="text-muted-foreground"> — {app.note}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SettingsCardBody>
    </SettingsSection>
  );
}
