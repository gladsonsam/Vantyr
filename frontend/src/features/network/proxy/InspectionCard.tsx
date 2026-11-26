import { Card, CardContent } from "@vantyr/ui/components/card";
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
    <Card className="gap-0 py-0">
      <CardContent className="space-y-6 p-5">
        <div className="flex items-center gap-1.5">
          <h3 className="font-medium">HTTPS inspection</h3>
          <HelpTip label="About HTTPS inspection">
            Lets the proxy read encrypted web traffic so it can filter it. It needs every device to
            trust a certificate authority that only this server holds. Apps that pin their own
            certificates stop working, and the private key never leaves the server.
          </HelpTip>
        </div>

        <Stepper
          step={step}
          showFooter={false}
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
                Inspection is off. Turning it on creates the authority. Nothing is inspected yet.
              </p>
              <SlideCommit
                {...SLIDER}
                label="Slide to turn on"
                doneLabel="Turned on"
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
                  <div className="text-muted-foreground">Public fingerprint</div>
                  <CopyValue text={inspection.caFingerprint} label="Fingerprint" mono />
                  <div className="text-muted-foreground">
                    Valid until <TimeAgo iso={inspection.caNotAfter} />
                  </div>
                </div>
              ) : null}
              <p className="text-muted-foreground">
                {inspection.trustingDevices} of {inspection.totalDevices} devices report trusting
                it. Until they do, inspection is not working for them.
              </p>
              <SlideCommit
                {...SLIDER}
                label="Slide to turn off"
                doneLabel="Turned off"
                onConfirm={() => toggle.mutateAsync(false)}
              />
            </div>
          </Step>
          <Step title="Inspecting" description="Devices that trust the authority are inspected.">
            <p className="py-4 text-sm text-muted-foreground">
              Inspection is active for devices that trust the authority.
            </p>
          </Step>
        </Stepper>

        {inspection.pinnedApps.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-sm font-medium">Apps that won’t work</h4>
            <ul className="divide-y divide-border">
              {inspection.pinnedApps.map((app) => (
                <li key={app.id} className="py-2.5 text-sm">
                  <span className="font-medium">{app.name}</span>
                  <span className="text-muted-foreground"> — {app.note}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
