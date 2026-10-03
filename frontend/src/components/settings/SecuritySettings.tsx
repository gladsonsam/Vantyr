import { Box, Container, Header, SpaceBetween } from "../ui/console";

export function SecuritySettings() {
  return (
    <Container header={<Header variant="h2">Local settings password and consent</Header>}>
      <SpaceBetween size="m">
        <Box>
          Open Vantyr’s local settings on the device to set or change its settings password.
          Password changes require access to that device.
        </Box>
        <Box>
          Authorize modules in the device’s local settings. The dashboard can request
          permission revocation; enabling a module requires consent on the device.
        </Box>
        <Box fontSize="body-s" color="text-body-secondary">
          The current device password is not reported here. Previously stored server
          password policies are historical and do not show the password configured on a device.
        </Box>
      </SpaceBetween>
    </Container>
  );
}
