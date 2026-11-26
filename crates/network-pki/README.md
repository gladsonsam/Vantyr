# vantyr-network-pki

Backend-only PKI foundation for **Vantyr Network** (DNS / Proxy). This crate
owns one thing: a dedicated, application-generated **inspection root CA** whose
private key is encrypted at rest and only ever appears in process memory while
an operator unlocks it.

It is deliberately **not**:

* a user identity certificate authority,
* a Wi-Fi / RADIUS server certificate authority,
* a router, AP, RADIUS, MDM or mobile-app change,
* a live TLS interception or client-trust provisioning step,
* an HTTP API.

A later enrollment slice consumes only the public bundle from this crate. The
purpose is pinned in code as `vantyr-network-inspection-ca/v1` so no other CA can
be accidentally treated as this one.

## Files

For a CA named `inspection-ca` in a directory `DIR`:

| File | Mode | Contents |
| --- | --- | --- |
| `DIR/inspection-ca.vault.age` | `0600` | age-encrypted CA private key and public certificate metadata |
| `DIR/inspection-ca.public.json` | `0644` | public fingerprint, serial, validity, PEM certificate |
| `DIR/inspection-ca.cert.pem` | `0644` | public CA certificate |

Every file is created with **no-clobber** semantics: an existing file (including
a symlink) is an error, never an overwrite. Publication uses a same-directory
temporary file, mode set before writing, full file sync, then a single atomic
rename. The parent-directory sync after the rename is best effort: once the
rename has committed, a sync failure is not returned as an error, and the only
uncertainty is whether the new directory entry survives sudden power loss. Because
creation never replaces an entry, there is no false "old file was left intact"
claim to make. Failures *before* the rename leave no published file.

File creation is not a multi-file transaction. If `init` fails after the vault
was published but before both public files were written, the vault is intact and
the operator can complete the bundle with `export-public` / `recover` using the
same secret; the tool never overwrites a partially present public file.

The operator passphrase is read from a `--secret-file` path that must be a
regular, non-symlink file with mode exactly `0600`, at most 4 KiB. It is never an
argument, never echoed, and is held in a zeroizing `SecretString`. Decryption is
fail-closed: a wrong passphrase, truncation or tampering returns the same generic
error and no new file is created.

## Issue model

* `CaSigner::generate` is only reachable from an explicit operator `init` (or
  `rotate`). The key is freshly generated every time; nothing is hardcoded,
  shipped or shared.
* Leaves are ECDSA P-256, non-CA (`CA:FALSE`), `digitalSignature` key usage and
  `serverAuth` EKU. Validated DNS names and IP addresses are emitted as SANs;
  wildcards, malformed names, duplicates and more than 16 names are rejected.
* Default leaf validity is one day, hard-capped at seven days, and a leaf may
  never outlive its issuing CA.
* The returned leaf certificate, chain (`[leaf, CA]`) and PKCS#8 key are kept in
  separate fields so a later `rustls` integration can pass them straight to a
  server config.

## Rotation and recovery

`rotate` creates a **new independent CA** with a new vault and new public files
under a new name. It emits a machine-readable `<old-name>.retired.json` with
`status: "retired"`, both key fingerprints and an explicit note that client
trust-removal is an operator action this tool does not perform. The old vault is
not modified or deleted, and neither root automatically trusts leaves from the
other.

`export-public` / `recover` decrypts an existing vault with the operator secret
and recreates missing public files; it never rewrites an existing public file,
and a fingerprint mismatch is reported instead. Wrong-secret recovery fails
closed — there is no fallback that creates a new CA.

## Dependency rationale (verified against crates.io, 2026-11-26)

Versions are pinned exactly and the lockfile is the single source of truth.

| Crate | Version | Purpose / licence |
| --- | --- | --- |
| `rcgen` | 0.14.10 | X.509 generation; MIT OR Apache-2.0. Built with `default-features = false` and `aws_lc_rs`, so its default `ring` feature is **not** enabled. |
| `age` | 0.12.1 | Portable, standard age-encryption.org/v1 envelope with its native scrypt passphrase recipient; MIT OR Apache-2.0. Actively maintained (latest release 2026-07-14, repository commits through 2026-11). No custom AES envelope or KDF is implemented here. |
| `secrecy`, `zeroize` | 0.10.3, 1.9.2 | In-memory secret wrappers and zeroization on drop; Apache-2.0 OR MIT. |
| `sha2` | 0.10.9 | SHA-256 fingerprints of public DER; MIT OR Apache-2.0. |
| `tempfile` | 3.27.0 | Same-directory temporary files and no-clobber persist; MIT OR Apache-2.0. |
| `time` | 0.3.47 | UTC validity windows and RFC 3339 rendering; MIT OR Apache-2.0. |
| `serde`, `serde_json`, `base64` | 1.0.229, 1.0.154, 0.22.1 | Envelope/metadata encoding; Apache-2.0 OR MIT / MIT OR Apache-2.0. |
| `rustls` (dev only) | 0.23.46 | WebPKI validator used by tests to verify chains, hostnames and expiry; Apache-2.0 OR ISC OR MIT. Its default provider is aws-lc-rs; the `ring` feature is not enabled for this crate. |

The `rustls-pki-types` version already in the workspace lock is 1.16.0 and is
used transitively by rcgen/rustls. No fork or local patch of these crates is
used.

## CLI

```text
vantyr-network-ca init             --dir DIR --secret-file FILE [--name NAME] [--valid-days N] [--scrypt-log-n N]
vantyr-network-ca export-public    --dir DIR --secret-file FILE [--name NAME]
vantyr-network-ca recover          --dir DIR --secret-file FILE [--name NAME]
vantyr-network-ca check            --dir DIR --secret-file FILE [--name NAME]
vantyr-network-ca inspect-metadata --dir DIR [--name NAME]
vantyr-network-ca rotate           --dir DIR --secret-file FILE --new-secret-file FILE --old-name NAME --new-name NAME [--valid-days N] [--scrypt-log-n N]
```

`--scrypt-log-n` is bounded to 14..=20 (default 18). It exists so operators and
tests on constrained hosts can bound the cost explicitly; age records the chosen
work factor in the standard envelope and decryption enforces the same upper
bound. Release-mode `init` with the default takes under a second; debug builds
are much slower because age's work-factor calibration is unoptimized.

## Known gaps (out of scope for this slice)

No client trust bundle installation, no enrollment agent, no CRL/OCSP, no
interception pipeline, no certificate cache, no rotation of client trusts, and
no HTTP surface. A retired root remains trusted by any device that was already
taught to trust it until an operator removes it in a later onboarding flow.
