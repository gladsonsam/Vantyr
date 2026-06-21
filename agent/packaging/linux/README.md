# Vantyr Linux Agent

The Linux agent runs as a per-user process and connects directly to the Vantyr
server WebSocket. It does not use the Windows service/companion split.

## Install for dogfooding

Build the agent on Linux:

```bash
sudo apt-get install -y \
  libx11-dev libxrandr-dev libxtst-dev libxdo-dev \
  libxcb1-dev libxcb-randr0-dev libxcb-render0-dev libxcb-shape0-dev \
  libxcb-shm0-dev libxcb-xfixes0-dev libdbus-1-dev \
  libpipewire-0.3-dev libwayland-dev libxkbcommon-dev \
  libegl1-mesa-dev pkg-config

cd agent
cargo build --release
install -Dm755 target/release/vantyr-agent ~/.local/bin/vantyr-agent
install -Dm644 packaging/linux/vantyr-agent.service ~/.config/systemd/user/vantyr-agent.service
systemctl --user daemon-reload
systemctl --user enable --now vantyr-agent.service
```

For managed configuration, either create `~/.config/vantyr/vantyr-agent.env`:

```bash
AGENT_SERVER_URL=wss://your-server.example/ws/agent
AGENT_NAME=linux-workstation
AGENT_TOKEN=per-device-token
```

or import a JSON config file:

```bash
vantyr-agent --import-machine-config ./agent-config.json
```

Local config is stored at `$XDG_CONFIG_HOME/vantyr/config.json` or
`~/.config/vantyr/config.json` as JSON with `0600` file permissions. This is a
transitional store until Secret Service support is added. Builds from the first
Linux dogfood pass also read the legacy `~/.local/share/vantyr/config.dat` path
so early installs keep working.

## Arch + Hyprland prerequisites

Wayland screen capture on wlroots compositors (Hyprland/sway) uses **`grim`**
(via the `wlr-screencopy` protocol) — no PipeWire/portal needed:

```bash
sudo pacman -S grim
```

Hyprland active-window tracking uses `hyprctl -j activewindow`, and the capture
backend uses `hyprctl -j monitors` to stream the focused output.

### Keystroke capture permissions (Wayland-safe, optional)

Keystroke + AFK capture reads `/dev/input/event*` directly (evdev), which works
on Wayland (where portals block global key capture) and X11. It needs read
access to the input devices — add the agent user to the `input` group:

```bash
sudo usermod -aG input "$USER"   # log out/in (or reboot) for it to take effect
```

Without this, keystroke capture is disabled and the dashboard shows the
capability as `needs_privilege` (everything else keeps working).

## Current Linux capability status

- Connect/reconnect/token auth: implemented.
- Resource metrics: implemented (sysinfo).
- System info: implemented, incl. DMI identity (model/vendor/board) from
  `/sys/class/dmi/id` (serial fields are root-only).
- Screen streaming: **Wayland/wlroots (Hyprland/sway) via `grim`**; X11 via
  `xcap`. GNOME/KDE Wayland (portal + PipeWire) not yet implemented.
- File exploration: cross-platform; "This PC" lists `/` + mounts from
  `/proc/mounts`.
- Remote input injection: `enigo` on X11; Wayland not yet wired (needs uinput or
  RemoteDesktop portal + libei) — reported `unsupported`.
- Active window: Hyprland implemented; other desktops report limited support.
- Software inventory: pacman, dpkg, rpm, and flatpak implemented.
- Terminal: Unix PTY implemented, including resize.
- Script execution: `sh` and `bash` implemented.
- App blocking: `/proc` scan plus same-user `kill -TERM` implemented.
- Network blocking: nftables backend implemented and requires privilege.
- URL tracking: native address-bar scraping is Windows-only; unsupported on Linux.
- Keystroke + AFK capture: **evdev (`/dev/input/event*`) implemented** — works on
  Wayland and X11 with `input`-group access; US keymap, attributed to the active
  window. Non-US layouts not yet translated.
