# Recall storage and recovery

Recall images and thumbnails can be encrypted at rest with an application keyring.
This is server-side encryption: a running server and its administrators can decrypt
captures. It is not end-to-end encryption. Login and role checks still apply.

PostgreSQL retains searchable OCR text, foreground context and capture metadata.
Use an encrypted host disk/volume for the database, swap and filesystem snapshots.
Enabling image encryption does not encrypt these database fields or previously
freed disk blocks. Do not convert a live root partition in place: plan a verified
backup, recovery console, downtime and an encrypted replacement disk/install.

## Enable encryption on an existing installation

1. Make a consistent encrypted backup, including PostgreSQL, image storage and
   deployment configuration (see below). Verify it and test database restoration.
2. Stop the server. Keep its persistent image directory mounted at the same path.
3. Generate the keyring outside the image directory:

   ```sh
   vantyr-server recall-keygen /secure/recall-keyring.json
   ```

   Keep this file out of Git, container layers, public directories and logs. Mount
   it read-only into the server at `/run/secrets/recall-keyring.json`. The server
   user must be able to read it; use owner-only `0400` or `0600` permissions.
4. Set `SCREEN_HISTORY_KEYRING_FILE=/run/secrets/recall-keyring.json` and keep
   `SCREEN_HISTORY_DIR=/app/screen_history` pointing at persistent storage.
5. With the server still stopped, run the migration with the same mounts/config:

   ```sh
   vantyr-server recall-encrypt --dry-run
   vantyr-server recall-encrypt --apply
   ```

6. Start the server and check a capture and thumbnail through the authenticated
   API. Recreate the container once and check again. Back up the keyring and new
   encrypted data together before removing the old rollback copy.

Never generate a replacement key to resolve a missing-key error. Restore the
original keyring. Losing every copy of a required key makes those captures
unrecoverable. Restoring an older server binary against encrypted storage is not
a rollback: restore the matching old storage snapshot and database as well.

## Key rotation

AES-256-GCM uses a fresh random 96-bit nonce for every encrypted object. Rotate
well before 2^32 encryptions under one key (count thumbnails and markers too).
Generate a second keyring, retain both key entries in the working keyring, set
`active_key` to the new key ID, and run the offline dry-run/apply migration before
restarting. Keep old keys for backups that were created before rotation.

## Encrypted backups

Install `age` from a trusted package source. Generate a recovery identity on a
separate trusted machine:

```sh
umask 077
age-keygen -o backup-identity.txt
age-keygen -y backup-identity.txt > backup-recipient.txt
```

Store `backup-identity.txt` in a password manager or offline recovery storage.
Only copy the public `backup-recipient.txt` to the server. The server can encrypt
backups without possessing the private recovery identity.

Create a backup on the Docker Compose host:

```sh
python3 tools/secure_backup.py create \
  --project-dir /path/to/vantyr \
  --output /private/encrypted-backups \
  --recipient-file /secure/backup-recipient.txt \
  --keyring-container-path /run/secrets/recall-keyring.json
```

The output directory must be `0700`. The script briefly stops a running server
for consistency and restarts it even if backup fails. It streams PostgreSQL's
custom-format dump, the full Recall tree, the keyring and Compose configuration
(including `.env`) directly into separate authenticated `age` files. It publishes
a timestamped backup directory only after every producer and encryptor succeeds.
The tool detects the live container's configured Recall directory and always
includes its configured keyring; an explicit mismatched key override is rejected.
No plaintext database/config/image archive is staged on disk. Docker access is
required and is effectively administrator access. Keep backups off the source
machine too; a local backup does not protect against loss of that machine.

Verify on the trusted recovery machine:

```sh
python3 tools/secure_backup.py verify \
  --backup /path/to/timestamped-backup \
  --identity /secure/backup-identity.txt
```

This authenticates all encrypted bytes, checks archive paths and the PostgreSQL
dump header, and does not extract plaintext. A successful verify is not a full
restore test. Also restore the database into an isolated PostgreSQL instance:

```sh
set -o pipefail
age -d -i /secure/backup-identity.txt /backup/database.dump.age |
  pg_restore --no-owner --no-acl --dbname isolated_restore_test
```

For disaster recovery, stop the server and decrypt the archives into a private
`0700` recovery directory, restore the database into an empty compatible
PostgreSQL database, restore Recall files with app ownership/permissions, restore
the keyring read-only, and apply configuration with the correct volume paths.
Do not restore an entire old Compose file blindly over a newer deployment.
Validate image and thumbnail access before enabling capture again.

Old plaintext backups must also be encrypted and authenticated before removing
the original copies. Unlinking originals cannot guarantee erasure from SSDs,
filesystem snapshots, VM snapshots or existing offsite backups. Handle those
copies through their storage provider's encryption and retention controls.
