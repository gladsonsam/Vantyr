# Maintained voxl encoder fork

Source: https://github.com/tembo/voxl
Pinned commit: `21f194f9e446e7073abd7bbd52e0b397c3800b42`
Upstream version: 0.4.0
Imported: 2026-11-25

`src/encoder.rs` and `src/convert.rs` originate from that revision. `build.rs`
is reduced from upstream to discover only x264/libyuv and generate x264 bindings.
The upstream MIT license is preserved in LICENSE. `src/lib.rs` is the Vantyr
adapter: validates RGBA buffers, pads odd dimensions, converts channel order,
and forces independently decodable IDR frames for Vantyr's latest-frame relay.

This deliberately imports no upstream HTTP server, password login, filesystem,
clipboard or input commands. Vantyr retains those authorization boundaries and
its Windows service/session/secure-desktop supervisor.

Updating: compare the pinned files against a new upstream commit, review unsafe
FFI and native ABI changes, rerun codec tests and full agent checks, update the
pin here. Do not replace Vantyr's wrapper or change all-IDR until relay lag,
late-join and reconnect handling supports dependent frames.

The Rust files are MIT. The linked x264 library is GPL-2.0 (unless separately
licensed). Distribution of resulting binaries must use a compatible license /
source distribution arrangement or separately licensed replacement. The feature is selected explicitly by the CI and release workflows.
