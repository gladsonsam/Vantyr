# Maintained web-push-native compatibility patch

Upstream: https://github.com/leotaku/web-push-native
Crate: web-push-native 0.5.0
Source revision: 6b0a3f10377af3c9401a7c1a60b1e34d41155c5d (web_push directory)

The released crate still selects p256 0.13 and jwt-simple 0.12, pulling
crypto-bigint 0.5 with RUSTSEC-2026-0387. This local patch upgrades p256 and
jwt-simple to their current API lines and uses current rand/generic-array
utilities. The upstream RFC 8291 vectors, serialization and VAPID tests remain.
The encryption construction and wire format are unchanged. Both upstream
MIT and Apache-2.0 licenses are retained. Re-evaluate the patch when upstream
adopts the new RustCrypto dependencies; remove it once a fixed release exists.
