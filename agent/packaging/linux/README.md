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

Install the desktop capture stack:

```bash
sudo pacman -S pipewire wireplumber xdg-desktop-portal xdg-desktop-portal-hyprland
```

The first screen capture may require a portal prompt. Hyprland active-window
tracking uses `hyprctl -j activewindow`.

## Current Linux capability status

- Connect/reconnect/token auth: implemented.
- Resource metrics and system info: implemented.
- Screen streaming: uses the shared `xcap` backend; X11 is expected to work,
  Wayland depends on portal support.
- Remote input: uses the shared `enigo` backend; X11 is expected to work,
  Wayland depends on compositor/portal support.
- Active window: Hyprland implemented; other desktops report limited support.
- Software inventory: pacman, dpkg, rpm, and flatpak implemented.
- Terminal: Unix PTY implemented, including resize.
- Script execution: `sh` and `bash` implemented.
- App blocking: `/proc` scan plus same-user `kill -TERM` implemented.
- Network blocking: nftables backend implemented and requires privilege.
- URL tracking: browser-extension/native-messaging work remains.
- Keystroke capture: intentionally unsupported on Wayland.
