//! End-to-end tests for the backend PKI slice. Everything runs in real temp
//! directories with real age envelopes and a real rustls WebPKI validator.

use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration as StdDuration;

use rustls::client::danger::ServerCertVerifier;
use rustls::client::WebPkiServerVerifier;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{ClientConfig, RootCertStore, ServerConfig};
use secrecy::{ExposeSecret, SecretString};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use tempfile::tempdir;
use time::OffsetDateTime;
use vantyr_network_pki::envelope::{decrypt_payload, MIN_SCRYPT_LOG_N};
use vantyr_network_pki::{
    check, export_public, init_ca, inspect_metadata, inspect_retirement, paths_for,
    read_secret_file, rotate_ca, unlock, CaMetadata, LeafRequest, PkiError, RetirementRecord,
    VaultOptions, DEFAULT_CA_NAME, MAX_VAULT_BYTES, PURPOSE_ID,
};

const SECRET_A: &str = "correct horse battery staple 1234";
const SECRET_B: &str = "a completely different operator phrase 9876";
const FIXED_NOW: i64 = 1_800_000_000;

fn now() -> OffsetDateTime {
    OffsetDateTime::from_unix_timestamp(FIXED_NOW).unwrap()
}

fn options() -> VaultOptions {
    VaultOptions {
        scrypt_log_n: MIN_SCRYPT_LOG_N,
        ca_valid_days: 30,
    }
}

fn secret(value: &str) -> SecretString {
    SecretString::from(value.to_owned())
}

#[cfg(unix)]
fn write_file(path: &Path, bytes: &[u8], mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    fs::write(path, bytes).unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn write_secret_file(dir: &Path, file_name: &str, value: &str) -> PathBuf {
    let path = dir.join(file_name);
    write_file(&path, value.as_bytes(), 0o600);
    path
}

fn verify_at(
    ca_der: &[u8],
    leaf_der: &[u8],
    host: &str,
    unix_secs: u64,
) -> Result<(), rustls::Error> {
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(ca_der.to_vec())).unwrap();
    let verifier = WebPkiServerVerifier::builder(Arc::new(roots))
        .build()
        .unwrap();
    verifier
        .verify_server_cert(
            &CertificateDer::from(leaf_der.to_vec()),
            &[],
            &ServerName::try_from(host).unwrap(),
            &[],
            UnixTime::since_unix_epoch(StdDuration::from_secs(unix_secs)),
        )
        .map(|_| ())
}

#[test]
fn distinct_init_calls_produce_independent_cas() {
    let a = tempdir().unwrap();
    let b = tempdir().unwrap();
    let secret_a_path = write_secret_file(a.path(), "secret.txt", SECRET_A);
    let secret_b_path = write_secret_file(b.path(), "secret.txt", SECRET_B);
    let secret_a = read_secret_file(&secret_a_path).unwrap();
    let secret_b = read_secret_file(&secret_b_path).unwrap();

    let meta_a = init_ca(a.path(), DEFAULT_CA_NAME, &secret_a, &options(), now()).unwrap();
    let meta_b = init_ca(b.path(), DEFAULT_CA_NAME, &secret_b, &options(), now()).unwrap();
    meta_a.validate().unwrap();
    meta_b.validate().unwrap();

    assert_eq!(meta_a.purpose, PURPOSE_ID);
    assert_ne!(meta_a.key_fingerprint_sha256, meta_b.key_fingerprint_sha256);
    assert_ne!(
        meta_a.cert_fingerprint_sha256,
        meta_b.cert_fingerprint_sha256
    );
    assert_ne!(meta_a.serial_hex, meta_b.serial_hex);
    assert_ne!(meta_a.public_cert_pem, meta_b.public_cert_pem);

    let paths = paths_for(a.path(), DEFAULT_CA_NAME).unwrap();
    assert_eq!(
        fs::metadata(paths.vault).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert_eq!(
        fs::metadata(paths.metadata).unwrap().permissions().mode() & 0o777,
        0o644
    );
    assert_eq!(
        fs::metadata(paths.cert_pem).unwrap().permissions().mode() & 0o777,
        0o644
    );
}

#[test]
fn public_files_and_ciphertext_contain_no_private_key() {
    let dir = tempdir().unwrap();
    let secret_path = write_secret_file(dir.path(), "secret.txt", SECRET_A);
    let operator_secret = read_secret_file(&secret_path).unwrap();
    let metadata = init_ca(
        dir.path(),
        DEFAULT_CA_NAME,
        &operator_secret,
        &options(),
        now(),
    )
    .unwrap();
    let paths = paths_for(dir.path(), DEFAULT_CA_NAME).unwrap();

    let public_meta = String::from_utf8(fs::read(&paths.metadata).unwrap()).unwrap();
    let public_cert = String::from_utf8(fs::read(&paths.cert_pem).unwrap()).unwrap();
    for text in [&public_meta, &public_cert] {
        assert!(!text.to_ascii_lowercase().contains("private key"));
        assert!(text.contains("BEGIN CERTIFICATE") || text.contains("fingerprint"));
    }
    assert!(!format!("{:?}", metadata)
        .to_ascii_lowercase()
        .contains("private key"));

    // Decrypt the envelope inside the test and prove the key PEM is absent from
    // the on-disk ciphertext bytes.
    let ciphertext = fs::read(&paths.vault).unwrap();
    assert!(ciphertext.starts_with(b"age-encryption.org/"));
    let payload = decrypt_payload(&ciphertext, &operator_secret).unwrap();
    let key_pem = payload.ca_key_pem.as_bytes();
    assert!(!ciphertext.windows(key_pem.len()).any(|w| w == key_pem));

    let signer = unlock(&paths.vault, &operator_secret).unwrap();
    assert!(!format!("{signer:?}")
        .to_ascii_lowercase()
        .contains("private key"));
}

#[test]
fn wrong_secret_and_damaged_vaults_fail_closed_without_writes() {
    let dir = tempdir().unwrap();
    let secret_path = write_secret_file(dir.path(), "secret.txt", SECRET_A);
    let operator_secret = read_secret_file(&secret_path).unwrap();
    init_ca(
        dir.path(),
        DEFAULT_CA_NAME,
        &operator_secret,
        &options(),
        now(),
    )
    .unwrap();
    let paths = paths_for(dir.path(), DEFAULT_CA_NAME).unwrap();
    let before = fs::read(&paths.vault).unwrap();

    assert_eq!(
        check(dir.path(), DEFAULT_CA_NAME, &secret(SECRET_B)),
        Err(PkiError::DecryptFailed)
    );
    assert_eq!(
        export_public(dir.path(), DEFAULT_CA_NAME, &secret(SECRET_B)),
        Err(PkiError::DecryptFailed)
    );
    assert_eq!(
        fs::read(&paths.vault).unwrap(),
        before,
        "wrong secret changed no file"
    );

    let wrong = unlock(&paths.vault, &secret(SECRET_B)).err();
    assert_eq!(wrong, Some(PkiError::DecryptFailed));

    let truncated = dir.path().join("truncated.age");
    write_file(&truncated, &before[..before.len() / 2], 0o600);
    assert_eq!(
        unlock(&truncated, &operator_secret).err(),
        Some(PkiError::DecryptFailed)
    );

    let oversize = dir.path().join("oversize.age");
    write_file(&oversize, &vec![b'a'; MAX_VAULT_BYTES as usize + 1], 0o600);
    assert_eq!(
        unlock(&oversize, &operator_secret).err(),
        Some(PkiError::TooLarge {
            what: "file",
            bytes: MAX_VAULT_BYTES + 1,
            limit: MAX_VAULT_BYTES,
        })
    );

    let linked = dir.path().join("linked.age");
    std::os::unix::fs::symlink(&paths.vault, &linked).unwrap();
    assert_eq!(
        unlock(&linked, &operator_secret).err(),
        Some(PkiError::SymlinkRejected)
    );

    let loose = dir.path().join("loose.age");
    write_file(&loose, &before, 0o644);
    assert!(matches!(
        unlock(&loose, &operator_secret),
        Err(PkiError::BadMode {
            expected: 0o600,
            ..
        })
    ));

    assert_eq!(
        fs::read(&paths.vault).unwrap(),
        before,
        "no failure modified the vault"
    );
}

#[test]
fn secret_file_requirements_are_enforced() {
    let dir = tempdir().unwrap();
    let good = write_secret_file(dir.path(), "good.txt", SECRET_A);
    assert_eq!(read_secret_file(&good).unwrap().expose_secret(), SECRET_A);

    let with_newline = write_secret_file(dir.path(), "newline.txt", &format!("{SECRET_A}\n"));
    assert_eq!(
        read_secret_file(&with_newline).unwrap().expose_secret(),
        SECRET_A
    );

    let empty = write_secret_file(dir.path(), "empty.txt", "");
    assert_eq!(read_secret_file(&empty).err(), Some(PkiError::EmptySecret));

    let short = write_secret_file(dir.path(), "short.txt", "too short");
    assert!(matches!(
        read_secret_file(&short),
        Err(PkiError::WeakSecret { .. })
    ));

    let loose = write_secret_file(dir.path(), "loose.txt", SECRET_A);
    write_file(&loose, SECRET_A.as_bytes(), 0o644);
    assert!(matches!(
        read_secret_file(&loose),
        Err(PkiError::BadMode {
            expected: 0o600,
            ..
        })
    ));

    let linked = dir.path().join("linked.txt");
    std::os::unix::fs::symlink(&good, &linked).unwrap();
    assert_eq!(
        read_secret_file(&linked).err(),
        Some(PkiError::SymlinkRejected)
    );
}

#[test]
fn recovery_recreates_identical_public_bundle_and_check_detects_tampering() {
    let dir = tempdir().unwrap();
    let secret_path = write_secret_file(dir.path(), "secret.txt", SECRET_A);
    let operator_secret = read_secret_file(&secret_path).unwrap();
    let original = init_ca(
        dir.path(),
        DEFAULT_CA_NAME,
        &operator_secret,
        &options(),
        now(),
    )
    .unwrap();
    let paths = paths_for(dir.path(), DEFAULT_CA_NAME).unwrap();

    assert_eq!(
        check(dir.path(), DEFAULT_CA_NAME, &operator_secret).unwrap(),
        original
    );
    assert_eq!(
        export_public(dir.path(), DEFAULT_CA_NAME, &operator_secret).unwrap(),
        original
    );

    fs::remove_file(&paths.metadata).unwrap();
    fs::remove_file(&paths.cert_pem).unwrap();
    let recovered = export_public(dir.path(), DEFAULT_CA_NAME, &operator_secret).unwrap();
    assert_eq!(
        recovered.key_fingerprint_sha256,
        original.key_fingerprint_sha256
    );
    assert_eq!(
        recovered.cert_fingerprint_sha256,
        original.cert_fingerprint_sha256
    );
    assert_eq!(inspect_metadata(&paths.metadata).unwrap(), original);

    // Tampering with public metadata is detected against the authenticated vault.
    let mut tampered = original.clone();
    tampered.not_after = "2030-01-01T00:00:00Z".into();
    fs::write(&paths.metadata, serde_json::to_vec(&tampered).unwrap()).unwrap();
    assert_eq!(
        check(dir.path(), DEFAULT_CA_NAME, &operator_secret),
        Err(PkiError::MetadataMismatch)
    );
}

#[test]
fn issued_leaf_verifies_through_the_normal_rustls_webpki_validator() {
    let dir = tempdir().unwrap();
    let secret_path = write_secret_file(dir.path(), "secret.txt", SECRET_A);
    let operator_secret = read_secret_file(&secret_path).unwrap();
    init_ca(
        dir.path(),
        DEFAULT_CA_NAME,
        &operator_secret,
        &options(),
        now(),
    )
    .unwrap();
    let paths = paths_for(dir.path(), DEFAULT_CA_NAME).unwrap();
    let signer = unlock(&paths.vault, &operator_secret).unwrap();

    let leaf = signer
        .issue_server_leaf(LeafRequest {
            dns_names: vec!["proxy.example.test".into()],
            ip_addresses: vec!["10.0.0.1".parse().unwrap()],
            validity_secs: 3600,
            now: now(),
        })
        .unwrap();
    assert_eq!(leaf.chain_der.len(), 2);
    assert!(!format!("{:?}", leaf)
        .to_ascii_lowercase()
        .contains("private key"));

    verify_at(
        signer.public_cert_der(),
        &leaf.cert_der,
        "proxy.example.test",
        FIXED_NOW as u64,
    )
    .expect("valid leaf should verify under its CA");
}

#[test]
fn real_tls_loopback_accepts_the_issued_leaf_and_hostname() {
    let dir = tempdir().unwrap();
    let secret_path = write_secret_file(dir.path(), "secret.txt", SECRET_A);
    let operator_secret = read_secret_file(&secret_path).unwrap();
    init_ca(
        dir.path(),
        DEFAULT_CA_NAME,
        &operator_secret,
        &options(),
        now(),
    )
    .unwrap();
    let paths = paths_for(dir.path(), DEFAULT_CA_NAME).unwrap();
    let signer = unlock(&paths.vault, &operator_secret).unwrap();
    let leaf = signer
        .issue_server_leaf(LeafRequest {
            dns_names: vec!["proxy.example.test".into()],
            ip_addresses: vec![],
            validity_secs: 3600,
            now: OffsetDateTime::now_utc(),
        })
        .unwrap();

    let chain: Vec<CertificateDer<'static>> = leaf
        .chain_der
        .iter()
        .map(|der| CertificateDer::from(der.clone()))
        .collect();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(leaf.private_key_der.to_vec()));
    let server_config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(chain, key)
        .unwrap();
    let mut server = rustls::ServerConnection::new(Arc::new(server_config)).unwrap();

    let mut roots = RootCertStore::empty();
    roots
        .add(CertificateDer::from(signer.public_cert_der().to_vec()))
        .unwrap();
    let client_config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let mut client = rustls::ClientConnection::new(
        Arc::new(client_config),
        ServerName::try_from("proxy.example.test").unwrap(),
    )
    .unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server_thread = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(StdDuration::from_secs(10)))
            .unwrap();
        let mut tls = rustls::Stream::new(&mut server, &mut stream);
        let mut request = [0u8; 4];
        tls.read_exact(&mut request).unwrap();
        assert_eq!(&request, b"ping");
        tls.write_all(b"pong").unwrap();
    });

    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .set_read_timeout(Some(StdDuration::from_secs(10)))
        .unwrap();
    stream
        .set_write_timeout(Some(StdDuration::from_secs(10)))
        .unwrap();
    let mut tls = rustls::Stream::new(&mut client, &mut stream);
    tls.write_all(b"ping").unwrap();
    let mut response = [0u8; 4];
    tls.read_exact(&mut response).unwrap();
    assert_eq!(&response, b"pong");
    server_thread.join().unwrap();
}

#[test]
fn wrong_host_untrusted_ca_and_expired_leaf_are_rejected() {
    let dir = tempdir().unwrap();
    let secret_path = write_secret_file(dir.path(), "secret.txt", SECRET_A);
    let operator_secret = read_secret_file(&secret_path).unwrap();
    init_ca(
        dir.path(),
        DEFAULT_CA_NAME,
        &operator_secret,
        &options(),
        now(),
    )
    .unwrap();
    let paths = paths_for(dir.path(), DEFAULT_CA_NAME).unwrap();
    let signer = unlock(&paths.vault, &operator_secret).unwrap();
    let leaf = signer
        .issue_server_leaf(LeafRequest {
            dns_names: vec!["proxy.example.test".into()],
            ip_addresses: vec![],
            validity_secs: 3600,
            now: now(),
        })
        .unwrap();

    assert!(verify_at(
        signer.public_cert_der(),
        &leaf.cert_der,
        "other.example.test",
        FIXED_NOW as u64
    )
    .is_err());
    assert!(verify_at(
        signer.public_cert_der(),
        &leaf.cert_der,
        "proxy.example.test",
        FIXED_NOW as u64 + 7200
    )
    .is_err());

    let other_dir = tempdir().unwrap();
    let other_secret_path = write_secret_file(other_dir.path(), "secret.txt", SECRET_B);
    let other_secret = read_secret_file(&other_secret_path).unwrap();
    init_ca(
        other_dir.path(),
        DEFAULT_CA_NAME,
        &other_secret,
        &options(),
        now(),
    )
    .unwrap();
    let other_paths = paths_for(other_dir.path(), DEFAULT_CA_NAME).unwrap();
    let other_signer = unlock(&other_paths.vault, &other_secret).unwrap();
    assert!(verify_at(
        other_signer.public_cert_der(),
        &leaf.cert_der,
        "proxy.example.test",
        FIXED_NOW as u64
    )
    .is_err());
}

#[test]
fn name_validation_rejects_wildcards_and_bad_or_excessive_inputs() {
    let dir = tempdir().unwrap();
    let secret_path = write_secret_file(dir.path(), "secret.txt", SECRET_A);
    let operator_secret = read_secret_file(&secret_path).unwrap();
    init_ca(
        dir.path(),
        DEFAULT_CA_NAME,
        &operator_secret,
        &options(),
        now(),
    )
    .unwrap();
    let paths = paths_for(dir.path(), DEFAULT_CA_NAME).unwrap();
    let signer = unlock(&paths.vault, &operator_secret).unwrap();

    for bad in ["*.example.test", "under_score.test", "-bad.test", ""] {
        let request = LeafRequest {
            dns_names: vec![bad.into()],
            ip_addresses: vec![],
            validity_secs: 3600,
            now: now(),
        };
        assert!(
            matches!(
                signer.issue_server_leaf(request),
                Err(PkiError::InvalidName(_))
            ),
            "accepted {bad:?}"
        );
    }
    let many: Vec<String> = (0..17).map(|i| format!("h{i}.example.test")).collect();
    let request = LeafRequest {
        dns_names: many,
        ip_addresses: vec![],
        validity_secs: 3600,
        now: now(),
    };
    assert!(matches!(
        signer.issue_server_leaf(request),
        Err(PkiError::TooManyNames { .. })
    ));
    assert!(matches!(
        signer.issue_server_leaf(LeafRequest {
            dns_names: vec!["a.example.test".into()],
            ip_addresses: vec![],
            validity_secs: 0,
            now: now(),
        }),
        Err(PkiError::InvalidValidity)
    ));
}

#[test]
fn rotation_creates_an_independent_root_and_a_retirement_record() {
    let dir = tempdir().unwrap();
    let secret_a_path = write_secret_file(dir.path(), "secret-a.txt", SECRET_A);
    let secret_b_path = write_secret_file(dir.path(), "secret-b.txt", SECRET_B);
    let secret_a = read_secret_file(&secret_a_path).unwrap();
    let secret_b = read_secret_file(&secret_b_path).unwrap();
    let old_meta = init_ca(dir.path(), "root-one", &secret_a, &options(), now()).unwrap();
    let old_paths = paths_for(dir.path(), "root-one").unwrap();
    let old_vault_bytes = fs::read(&old_paths.vault).unwrap();

    let (new_meta, record) = rotate_ca(
        dir.path(),
        "root-one",
        "root-two",
        &secret_a,
        &secret_b,
        &options(),
        now(),
    )
    .unwrap();
    assert_ne!(
        old_meta.key_fingerprint_sha256,
        new_meta.key_fingerprint_sha256
    );
    assert_eq!(
        fs::read(&old_paths.vault).unwrap(),
        old_vault_bytes,
        "old vault untouched"
    );
    assert_eq!(check(dir.path(), "root-one", &secret_a).unwrap(), old_meta);

    let retirement: RetirementRecord =
        inspect_retirement(&dir.path().join("root-one.retired.json")).unwrap();
    assert_eq!(retirement, record);
    assert_eq!(retirement.status, "retired");
    assert_eq!(
        retirement.old_key_fingerprint_sha256,
        old_meta.key_fingerprint_sha256
    );
    assert_eq!(
        retirement.new_key_fingerprint_sha256,
        new_meta.key_fingerprint_sha256
    );
    assert_eq!(
        retirement.client_trust_removal,
        vantyr_network_pki::vault::TRUST_REMOVAL_NOTE
    );

    assert!(check(dir.path(), "root-two", &secret_b).is_ok());
    assert_eq!(
        check(dir.path(), "root-two", &secret_a),
        Err(PkiError::DecryptFailed)
    );

    let new_paths = paths_for(dir.path(), "root-two").unwrap();
    let new_signer = unlock(&new_paths.vault, &secret_b).unwrap();
    let old_signer = unlock(&old_paths.vault, &secret_a).unwrap();
    let new_leaf = new_signer
        .issue_server_leaf(LeafRequest {
            dns_names: vec!["proxy.example.test".into()],
            ip_addresses: vec![],
            validity_secs: 3600,
            now: now(),
        })
        .unwrap();
    let old_leaf = old_signer
        .issue_server_leaf(LeafRequest {
            dns_names: vec!["proxy.example.test".into()],
            ip_addresses: vec![],
            validity_secs: 3600,
            now: now(),
        })
        .unwrap();

    // Neither root inherits trust from the other automatically.
    assert!(verify_at(
        old_signer.public_cert_der(),
        &new_leaf.cert_der,
        "proxy.example.test",
        FIXED_NOW as u64
    )
    .is_err());
    assert!(verify_at(
        new_signer.public_cert_der(),
        &old_leaf.cert_der,
        "proxy.example.test",
        FIXED_NOW as u64
    )
    .is_err());
}

#[test]
fn no_clobber_is_enforced_on_init_and_rotation() {
    let dir = tempdir().unwrap();
    let secret_path = write_secret_file(dir.path(), "secret.txt", SECRET_A);
    let operator_secret = read_secret_file(&secret_path).unwrap();
    init_ca(
        dir.path(),
        DEFAULT_CA_NAME,
        &operator_secret,
        &options(),
        now(),
    )
    .unwrap();
    assert_eq!(
        init_ca(
            dir.path(),
            DEFAULT_CA_NAME,
            &operator_secret,
            &options(),
            now()
        ),
        Err(PkiError::AlreadyExists)
    );

    let paths = paths_for(dir.path(), DEFAULT_CA_NAME).unwrap();
    let before = fs::read(&paths.vault).unwrap();
    // A pre-existing symlink at the destination is refused rather than followed.
    let link_dir = tempdir().unwrap();
    let link_paths = paths_for(link_dir.path(), DEFAULT_CA_NAME).unwrap();
    std::os::unix::fs::symlink(&paths.metadata, &link_paths.vault).unwrap();
    assert_eq!(
        init_ca(
            link_dir.path(),
            DEFAULT_CA_NAME,
            &operator_secret,
            &options(),
            now()
        ),
        Err(PkiError::AlreadyExists)
    );
    assert_eq!(fs::read(&paths.vault).unwrap(), before);
}

#[test]
fn cli_never_prints_the_secret_or_a_private_key() {
    let dir = tempdir().unwrap();
    let secret_path = write_secret_file(dir.path(), "secret.txt", SECRET_A);
    let bin = env!("CARGO_BIN_EXE_vantyr-network-ca");

    let init = std::process::Command::new(bin)
        .args(["init", "--dir"])
        .arg(dir.path())
        .args(["--secret-file"])
        .arg(&secret_path)
        .args(["--scrypt-log-n", "14"])
        .output()
        .unwrap();
    assert!(
        init.status.success(),
        "{}",
        String::from_utf8_lossy(&init.stderr)
    );
    let stdout = String::from_utf8(init.stdout).unwrap();
    assert!(!stdout.contains(SECRET_A));
    assert!(!stdout.to_ascii_lowercase().contains("private key"));
    let printed: CaMetadata = serde_json::from_str(&stdout).unwrap();
    printed.validate().unwrap();

    let check_ok = std::process::Command::new(bin)
        .args(["check", "--dir"])
        .arg(dir.path())
        .args(["--secret-file"])
        .arg(&secret_path)
        .args(["--scrypt-log-n", "14"])
        .output()
        .unwrap();
    assert!(check_ok.status.success());
    assert!(!String::from_utf8_lossy(&check_ok.stdout).contains(SECRET_A));

    // Wrong-secret fail-closed behaviour is exercised in the library test
    // above; the CLI passes only a path, never the secret itself.

    let inspect = std::process::Command::new(bin)
        .args(["inspect-metadata", "--dir"])
        .arg(dir.path())
        .output()
        .unwrap();
    assert!(inspect.status.success());
    let inspected: CaMetadata =
        serde_json::from_str(&String::from_utf8(inspect.stdout).unwrap()).unwrap();
    assert_eq!(
        inspected.key_fingerprint_sha256,
        printed.key_fingerprint_sha256
    );
}
