# Vantyr uninstall cleanup — restore Windows Firewall to defaults and remove ProgramData.
# Errors are suppressed: if internet was never blocked, the netsh calls are no-ops.
# Runs as a WiX custom action (SYSTEM, elevated) before InstallFinalize during uninstall.

# Restore default outbound policy first so connectivity returns immediately.
$null = & netsh advfirewall set allprofiles firewallpolicy blockinbound,allowoutbound 2>&1

# Remove per-rule exceptions added by the internet-block feature.
foreach ($rule in @("VantyrAllowServer", "VantyrAllowDNS", "VantyrAllowDHCP")) {
    $null = & netsh advfirewall firewall delete rule name=$rule 2>&1
}

# Remove all Vantyr data: config, logs, update staging, enrollment files.
$pd = Join-Path $env:ProgramData "Vantyr"
if (Test-Path $pd) {
    Remove-Item -Recurse -Force $pd -ErrorAction SilentlyContinue
}
