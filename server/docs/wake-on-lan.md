# Direct server-to-client Wake-on-LAN

In device details, choose Wake on LAN. In the fleet, select devices and choose
Wake on LAN. The send dialog accepts an IPv4 broadcast address and UDP port.
Defaults remain `255.255.255.255` and `9` for existing same-VLAN installations.
Overrides apply to this send; they are not saved as device configuration. A fleet
send uses one destination for the entire selection: select devices in one VLAN at
a time when using different subnet broadcasts.

## What Vantyr sends

The server sends a UDP magic packet directly from its own network namespace. The
browser only requests the send. There is no agent-to-agent relay. Routing and
source-interface selection are controlled by the server host's operating system.
The MAC is selected from non-loopback adapters in the device's last
stored system info. Missing adapter fields can prevent selection. Connect the agent once to record it. On a multi-adapter
machine, verify this is the adapter that supports waking; Vantyr does not currently
provide an adapter selector.

A successful response means the UDP send completed locally. It cannot confirm
that the packet arrived or the device woke. The API retains `ok: true` and adds
`packet_sent: true` and `awakening_confirmed: false`, alongside `mac`, `broadcast`,
and `port`. Wait for the agent to reconnect and appear online to confirm it is
available; a later connection does not prove the packet caused the awakening.

## Across VLANs

The limited broadcast `255.255.255.255` does not route to another VLAN. Supply the
target subnet's directed broadcast instead. For example, a device on
`192.168.20.0/24` uses `192.168.20.255`; compute the address from the actual subnet
mask, rather than assuming every subnet ends in `.255`.

The server must have a route to that subnet. The destination router must support
and explicitly permit forwarding directed broadcasts onto the target VLAN, and
host/network firewalls must permit UDP from the server to that broadcast address
and chosen port. Restrict any broadcast allowance to the trusted server source
and required destination/port. Routers default to blocking directed broadcasts
under [RFC 2644](https://www.rfc-editor.org/rfc/rfc2644).

If the router cannot support or permit directed broadcasts, application changes
alone cannot make this direct delivery work. Changing the UDP port does not
bypass that limitation. Container, VM, VPN, or cloud networking around the server
may also block broadcasts; assess the path from the server's network namespace,
not from the browser's machine.

## Troubleshooting

1. Enable Wake-on-LAN in the target's firmware and NIC/OS settings. Verify support
   for its current power state and test on the same VLAN first.
2. Check the reported MAC against the intended physical adapter. Stored adapter
   data can be stale, and virtual adapters may be selected.
3. Check the server route, directed-broadcast configuration, and UDP firewall
   rules. Capture traffic on the server and target VLAN to locate packet loss.
4. If the packet reaches the target VLAN but the device stays offline, check NIC
   power, firmware/driver settings, and agent startup/connectivity.

The endpoint is `POST /api/agents/{id}/wake` (under the configured API prefix),
with optional `broadcast` and `port` query parameters. Operator privileges and
the existing per-agent send throttle still apply. Invalid IPv4 addresses or ports
outside `1..65535` are rejected. No subnet is inferred automatically.
