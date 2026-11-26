# Third-party notices — isolated Vantyr DNS lab image

This notice accompanies the `vantyr-dns` binary built by
`tests/network-lab/Dockerfile.vantyr`. The binary statically links the
maintained crates below; no dependency is forked and no low-level DNS or
adblock parser is reimplemented in this lab.

| Concern | Upstream | License | Use in the worker |
| --- | --- | --- | --- |
| DNS catalog, in-memory/forwarding zones, hosts/bare/wildcard blocklists | Hickory DNS `hickory-server` 0.26.4 | MIT OR Apache-2.0 | zone serving and operators' hosts lists |
| DNS-representable ABP domain rules (`||host^`, `@@||host^`, `$important`) | `adblock` 0.13.6 (Brave `adblock-rust`, <https://github.com/brave/adblock-rust>) | **MPL-2.0** | compiled via `vantyr-network-filter`'s default `abp` feature |
| Durable typed last-known-good bundle | `vantyr-network-runtime` (this repository) | MIT | local, unauthenticated bundle persistence |

The full licence texts ship with the pinned crate sources in the Cargo
registry used by the builder layer; this file records attribution in the
runtime layer, which otherwise contains only the compiled binary. The
operator-supplied list and service fixtures used by the lab are synthetic;
`source_url` fields are attribution metadata only and are never dereferenced.

MPL-2.0: <https://www.mozilla.org/en-US/MPL/2.0/>.
