import { Card, CardContent, CardHeader, CardTitle } from "@vantyr/ui/components/card";

export function SecuritySettings() {
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle>Local settings password and consent</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-5 pb-5 text-sm">
        <p>
          Open Vantyr’s local settings on the device to set or change its settings password.
          Password changes require access to that device.
        </p>
        <p>
          Authorize modules in the device’s local settings. The dashboard can request
          permission revocation; enabling a module requires consent on the device.
        </p>
        <p className="text-muted-foreground">
          Device-local approval is the standard mode. Authorized files, terminal,
          scripts, or desktop control can also change local settings; local approval
          does not prevent those tools from changing module permissions.
        </p>
        <p className="text-muted-foreground">
          The current device password is not reported here. Previously stored server
          password policies are historical and do not show the password configured on a device.
        </p>
      </CardContent>
    </Card>
  );
}
