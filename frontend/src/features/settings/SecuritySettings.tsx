import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";
import { HelpTip } from "@/components/common/HelpTip";

/** Where device passwords and module consent live: on the device, never in the dashboard. */
export function SecuritySettings() {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="flex items-center gap-1.5">
          Device password and consent
          <HelpTip>
            Remote files, terminal, scripts or desktop control can still change local settings. The
            device password is never reported here; older server password policies are historical
            only.
          </HelpTip>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 px-5 pb-5 text-sm text-muted-foreground">
        <p>Set the password and turn modules on in the local settings on the device.</p>
        <p>The dashboard can stop a module, but turning one on needs consent on the device.</p>
      </CardContent>
    </Card>
  );
}
