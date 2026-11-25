// @effect-diagnostics nodeBuiltinImport:off -- Streams whole backups through node:crypto, zlib and fs; Effect's crypto has no streaming AES-GCM or scrypt.
// Snapshot directory → tar → gzip → encryption → one file, and back.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import type { DataSnapshotManifest } from "@t3tools/plugin-api";

import { packFiles, unpackTo } from "./archive.ts";
import {
  createDecryptStream,
  createDigestStream,
  createEncryptStream,
  type EncryptOptions,
} from "./crypto.ts";
import { archivedPaths, verifySnapshot } from "./snapshot.ts";

/** Writes the encrypted backup to `destination` (which must not exist); returns its size and SHA-256. */
export async function sealSnapshot(input: {
  readonly directory: string;
  readonly manifest: DataSnapshotManifest;
  readonly destination: string;
  readonly passphrase: string;
  readonly encryption?: EncryptOptions;
}): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const digest = createDigestStream();
  await pipeline(
    packFiles(input.directory, archivedPaths(input.manifest)),
    NodeZlib.createGzip(),
    await createEncryptStream(input.passphrase, input.encryption),
    digest,
    NodeFS.createWriteStream(input.destination, { flags: "wx", mode: 0o600 }),
  );
  return digest.result();
}

/**
 * Decrypts and unpacks a backup into `directory` (created here, must not exist), then
 * checks it against its manifest. Any wrong passphrase, tampering or damage rejects.
 */
export async function openBackup(input: {
  readonly file: string;
  readonly directory: string;
  readonly passphrase: string;
}): Promise<DataSnapshotManifest> {
  await NodeFSP.mkdir(input.directory, { mode: 0o700 });
  await pipeline(
    NodeFS.createReadStream(input.file),
    createDecryptStream(input.passphrase),
    NodeZlib.createGunzip(),
    async (source: AsyncIterable<Buffer>) => {
      await unpackTo(source, input.directory);
      // Read to the end so the final chunk's authentication runs.
      for await (const _ of source);
    },
  );
  return verifySnapshot(input.directory);
}
