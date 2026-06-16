# Vantyr Browser URL Provider

This is the cross-platform browser-extension direction for URL tracking. The
extension observes the active tab URL/title and forwards it to a native
messaging host named `com.vantyr.agent`.

Current status:

- Chromium-family manifest: included.
- Firefox manifest: included.
- Background script: included.
- Native host bridge: pending Linux/Windows installer integration.
- Private/incognito windows: not enabled by default; browser policy must opt in.

Installers should place native messaging manifests in the browser-specific
locations and point them at a small host executable or script that forwards
messages to the local Vantyr agent IPC/socket.

