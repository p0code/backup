# Backups (p0code plugin)

An off-by-default [p0code](https://github.com/p0code/p0code) server plugin that backs up your
chats so you can get them back after a lost disk, a broken machine or a bad update. It copies
the server's state database, attachments, `settings.json` and `keybindings.json`, encrypts the
copy **on your machine** with your passphrase, and uploads it to **Google Drive** or any
**S3-compatible** storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO…). The remote only ever
sees ciphertext.

- Hourly, daily or weekly backups, plus **Back up now**
- Keeps the newest _N_ backups of this machine; never prunes another machine's backups
- Lists, **verifies** (download, decrypt, check every file) and **restores** any backup
- Restores never touch live data: the plugin hands a verified copy to p0code, which asks you to
  confirm and swaps it in on restart, keeping what it replaced

> [!WARNING]
> **A lost passphrase means lost backups.** Nobody can decrypt them without it: not the storage
> provider, not p0code, not you. The passphrase is kept in this machine's keychain so scheduled
> backups run unattended, but the machine is exactly what you are protecting against. Keep a
> copy somewhere else, such as a password manager.

Never backed up: the `secrets/` folder and OS keychain entries (provider sign-ins, device
pairings, signing keys). After a restore on a new machine you sign in to providers and pair
devices again.

## Status

This plugin needs a host API p0code does not have yet: a `data:backup` capability that takes a
consistent snapshot of the data and accepts a restore through p0code's own confirmation flow.
The proposal is in [docs/HOST_API.md](docs/HOST_API.md); the code here is written against it.

## Install

This repository ([p0code/backup](https://github.com/p0code/backup)) is mounted as the
`plugins/backup` git submodule of p0code and built inside that workspace, where it imports
`@t3tools/plugin-api`. See [Mounting](docs/HOST_API.md#mounting-this-plugin).

```sh
git clone --recurse-submodules https://github.com/p0code/p0code
cd p0code && pnpm install
pnpm --filter @t3tools/plugin-backup typecheck
pnpm --filter @t3tools/plugin-backup test
```

Then turn it on under **Settings → Plugins → Backups**, pick a target, set a passphrase (at least
12 characters; longer is better) and press **Back up now**.

## Google Drive

You use your own Google OAuth client, so no third party is involved and the plugin can only see
files it created (the `drive.file` scope), never the rest of your Drive.

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project (or pick
   one) and enable the **Google Drive API**.
2. **OAuth consent screen**: user type _External_ (or _Internal_ on Workspace), add yourself as a
   test user. Then set the publishing status to **In production**: apps left in _Testing_ get
   refresh tokens that expire after 7 days, which would stop scheduled backups. `drive.file` is
   a non-sensitive scope, so production needs no Google review.
3. **Credentials → Create credentials → OAuth client ID**, application type
   **TVs and Limited Input devices**. Copy the client ID and secret.
4. In p0code, choose **Google Drive**, paste the client ID and secret, **Save**, then
   **Sign in to Google Drive**. Open the link on any device, enter the code shown, approve.

Sign-in uses Google's device flow, so it works when p0code runs on a server and your browser is
elsewhere. Backups go to a folder named `p0code backups` in your Drive. A new machine signed in
with the same client sees the old machine's backups there.

## S3-compatible storage

Create a bucket and a key that can only touch it, then fill in endpoint, region, bucket, an
optional prefix (such as `p0code/`), access key ID and secret.

| Service       | Endpoint                                        | Region                         | Path-style |
| ------------- | ----------------------------------------------- | ------------------------------ | ---------- |
| AWS S3        | `https://s3.<region>.amazonaws.com`             | the bucket's, e.g. `eu-west-1` | off        |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com` | `auto`                         | on         |
| Backblaze B2  | `https://s3.<region>.backblazeb2.com`           | e.g. `us-west-004`             | off        |
| MinIO         | `http(s)://<host>:9000`                         | `us-east-1` (or as configured) | on         |

- **AWS**: an IAM user with this policy (replace the bucket and prefix):

  ```json
  {
    "Version": "2012-10-17",
    "Statement": [
      { "Effect": "Allow", "Action": "s3:ListBucket", "Resource": "arn:aws:s3:::my-bucket" },
      {
        "Effect": "Allow",
        "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
        "Resource": "arn:aws:s3:::my-bucket/p0code/*"
      }
    ]
  }
  ```

- **R2**: _R2 → Manage API tokens → Create API token_ with _Object Read & Write_ for the bucket;
  use the S3 access key ID and secret it shows.
- **B2**: create an application key limited to the bucket; the key ID is the access key ID. The
  region is the part of the bucket's S3 endpoint after `s3.`.
- **MinIO**: any access key with read/write on the bucket. Plain `http` works for a LAN server;
  the payload is encrypted either way, but the request metadata is not.

Requests are signed with AWS Signature Version 4 (implemented with `node:crypto`; no SDK), with
the real SHA-256 of each upload in `x-amz-content-sha256`, so the storage service rejects an
upload that was changed in transit. Uploads are a single `PUT`, which S3 and its compatibles
accept up to 5 GB.

## Encryption

A backup is `tar` → `gzip` → encrypt, written to the plugin's folder, uploaded, then deleted
locally.

- **Key**: scrypt (N = 2¹⁷, r = 8, p = 1; about 128 MiB of memory) of the passphrase in Unicode
  NFC, with a fresh random 16-byte salt per backup. Every backup has its own key.
- **Cipher**: AES-256-GCM over 1 MiB chunks, each with its own 16-byte tag, so backups of any
  size stream through a fixed amount of memory.
- **Nonces and ordering**: chunk _i_ uses the nonce `prefix (7 random bytes) ‖ i (4 bytes) ‖
  last (1 byte)`, the STREAM construction. The whole header is authenticated as associated data
  of every chunk. A changed header, a flipped bit, reordered, dropped or extra chunks, or a file
  cut at any point all fail to decrypt.
- **Versioned header** (37 bytes, big-endian):

  | Offset | Size | Field                                |
  | -----: | ---: | ------------------------------------ |
  |      0 |    5 | magic `P0BAK`                        |
  |      5 |    1 | format version (1)                   |
  |      6 |    1 | key derivation (1 = scrypt)          |
  |      7 |    3 | scrypt log₂N, r, p                   |
  |     10 |   16 | salt                                 |
  |     26 |    7 | nonce prefix                         |
  |     33 |    4 | plaintext bytes per chunk            |
  |     37 |    … | chunks: ciphertext ‖ 16-byte GCM tag |

  Decryption refuses parameters above log₂N = 20, r = 16, p = 4 so a forged header cannot make
  it exhaust memory.

What the remote can see: object names (`p0code-<environment>-<UTC time>.p0bak`), sizes and
upload times. Nothing else.

Changing the passphrase applies to new backups only. Older ones still need the passphrase they
were made with; **Verify** and **Restore** accept it when the stored one does not fit.

## Restore

**Show backups** lists every backup the target holds, from this machine and any other.
**Verify** downloads one, decrypts it and checks every file against the manifest inside.
**Restore** does the same and then hands the folder to p0code, which checks it again and asks
you to confirm. p0code swaps it in at the next start and keeps your current data in
`restore-replaced-<time>/` inside its home folder. A backup made by a newer p0code is refused.

On a new machine: install p0code, turn this plugin on, enter the same target settings and the
same passphrase, then restore.

## Development

The plugin builds inside the p0code workspace. To work on it on its own, `standalone/` holds a
small harness with the same compiler settings and Effect lint rules, and a stand-in for
`@t3tools/plugin-api` that includes the proposed host API:

```sh
pnpm --dir standalone install
pnpm --dir standalone test
pnpm --dir standalone typecheck
```

The tests cover the encryption round trip and tamper detection, SigV4 against AWS's published
test vectors, tar packing, retention, schedule math, and the whole service (back up, prune,
list, verify, restore) against a local fake S3 server.

| File                  | What it does                                                |
| --------------------- | ----------------------------------------------------------- |
| `src/index.ts`        | the plugin definition                                       |
| `src/actions.ts`      | action and settings schemas, shared with the settings panel |
| `src/backup.ts`       | settings, schedule, jobs, and the actions                   |
| `src/crypto.ts`       | streaming encryption                                        |
| `src/archive.ts`      | minimal tar writer and reader                               |
| `src/pipeline.ts`     | snapshot → backup file → snapshot                           |
| `src/snapshot.ts`     | checks an unpacked snapshot against its manifest            |
| `src/sigv4.ts`        | AWS Signature Version 4                                     |
| `src/s3.ts`           | S3 client                                                   |
| `src/drive.ts`        | Google device sign-in and Drive client                      |
| `src/backups.ts`      | backup names and retention                                  |
| `src/schedule.ts`     | when the next backup runs                                   |
| `web/BackupPanel.tsx` | settings panel draft, moved into `apps/web` when mounted    |
