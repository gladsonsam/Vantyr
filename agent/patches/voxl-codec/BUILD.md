# Building and validating Vantyr's voxl path

The existing JPEG protocol remains available. H.264 is negotiated only when the
agent reports `screen_h264: supported` and the browser supports WebCodecs.
Build the agent with `--features voxl` to advertise support. Builds without it
reject H.264 capture requests rather than emitting JPEG into an H.264 stream.

## Linux (X11)

Install native build prerequisites (Debian/Ubuntu package names):

```sh
sudo apt-get install build-essential pkg-config clang libclang-dev libx264-dev libyuv-dev
cargo test --manifest-path agent/Cargo.toml -p vantyr-voxl-codec --target x86_64-unknown-linux-gnu
cargo check --manifest-path agent/Cargo.toml --features voxl --target x86_64-unknown-linux-gnu
cargo build --manifest-path agent/Cargo.toml --release --features voxl --target x86_64-unknown-linux-gnu
```

The agent also needs its existing Linux capture/input build dependencies (see
agent/packaging/linux/README.md). This path currently advertises H.264 on X11
only; Wayland keeps the existing capture pipeline.

## Windows (native MSVC build)

Install Rust/MSVC, LLVM (bindgen), and vcpkg. From a developer PowerShell:

```powershell
vcpkg install x264 libyuv --triplet x64-windows-static-md
$env:VCPKGRS_TRIPLET = 'x64-windows-static-md'
# Set VCPKG_ROOT to the vcpkg checkout and LIBCLANG_PATH to LLVM/bin if not detected.
cargo test --manifest-path agent/Cargo.toml -p vantyr-voxl-codec --target x86_64-pc-windows-msvc
cargo check --manifest-path agent/Cargo.toml --features voxl --target x86_64-pc-windows-msvc
cargo build --manifest-path agent/Cargo.toml --release --features voxl --target x86_64-pc-windows-msvc
```

Cross compilation additionally needs Windows-target x264/libyuv archives and
headers discoverable by vcpkg; Linux native libraries cannot satisfy that build.
CI and release workflows install these native dependencies and enable `voxl`.
Windows execution and distribution obligations still require release validation.

## Wire format

`StartCapture.codec = "h264"` selects the codec. Each permission-fenced agent
binary contains `H264`, a little-endian u32 JSON length, JSON metadata, then an
Annex-B H.264 access unit. Metadata contains `type: capture_geometry`,
`schema_version: 1`, the usual `geometry`, `keyframe: true`, and `timestamp_us`.
Dimensions in geometry refer to the source image; encoder dimensions may be one
pixel larger for I420 padding. Every packet includes SPS/PPS/IDR so replacing a
queued frame or joining a running session never loses a reference frame.

## Required Windows device acceptance tests

These require an actual installed SYSTEM service and cannot be proven by Linux
compilation or unit tests:

1. Connect before login and control the sign-in screen.
2. Lock/unlock repeatedly; ensure stream resumes and stale coordinates cannot
   act on the new desktop.
3. Open/dismiss UAC on the secure desktop, including while input is held.
4. Switch monitors/DPI and users, disconnect/reconnect, restart service.
5. Revoke screen/input modules mid-stream and expire a control lease.
6. Verify clipboard and sound in the user session after every transition.

The SYSTEM worker recreates a capture OS thread on desktop transitions. Input
invalidates geometry immediately on desktop change and drops the command that
triggered reattachment. The normal geometry/permission fences stay enforced.

Audio remains the existing PCM stream; clipboard remains the existing text
module. Neither is supplied by this encoder-only fork. All-IDR currently trades
bandwidth efficiency for correct drop/late-join behavior; upstream's inter-frame
compression/adaptive rate controller is not imported.

## Actual decoder smoke check

```sh
cargo run --manifest-path agent/Cargo.toml -p vantyr-voxl-codec --example encode_fixture --target x86_64-unknown-linux-gnu -- /tmp/voxl-fixture.h264
ffprobe -v error -count_frames -show_entries stream=width,height,nb_read_frames -of json /tmp/voxl-fixture.h264
ffmpeg -v error -i /tmp/voxl-fixture.h264 -f rawvideo -pix_fmt rgba /tmp/voxl-fixture.rgba
```

Expected: three frames, encoded dimensions 66x34, 26,928 decoded RGBA bytes.
Source dimensions are 65x33; the browser clips the repeated right/bottom padding.
