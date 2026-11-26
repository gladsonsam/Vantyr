import { SettingsCardBody, SettingsSection } from "./components/SettingsLayout";

/** Where device passwords and module consent live: on the device, never in the dashboard. */
export function SecuritySettings() {
  return (
    <SettingsSection
      title="Device password and consent"
      help="Remote files, terminal, scripts or desktop control can still change local settings. The device password is never reported here; older server password policies are historical only."
    >
      <SettingsCardBody className="flex flex-col gap-1 space-y-0 text-sm text-muted-foreground">
        <p>Set the password and turn modules on in the local settings on the device.</p>
        <p>The dashboard can stop a module, but turning one on needs consent on the device.</p>
      </SettingsCardBody>
    </SettingsSection>
  );
}
