// @effect-diagnostics nodeBuiltinImport:off -- Builds real files and streams on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { DataSnapshotManifest } from "@t3tools/plugin-api";
import { afterEach, describe, expect, it } from "vitest";

import { BackupDecryptError } from "./crypto.ts";
import { openBackup, sealSnapshot } from "./pipeline.ts";
import { MANIFEST_FILE, SnapshotError } from "./snapshot.ts";

const FAST = { scrypt: { log2N: 10, r: 8, p: 1 }, chunkBytes: 4096 };
const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true })));
});

/** A snapshot directory laid out the way the proposed host API writes one. */
async function makeSnapshot(files: Record<string, Buffer>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p0bak-snap-"));
  temporary.push(directory);
  for (const [path, body] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(directory, path)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(directory, path), body);
  }
  const manifest: DataSnapshotManifest = {
    format: 1,
    createdAt: "2026-11-25T00:00:00.000Z",
    environmentId: "env-a",
    appVersion: "0.0.0-test",
    migrationHead: 119,
    files: Object.entries(files).map(([path, body]) => ({
      path,
      bytes: body.length,
      sha256: NodeCrypto.createHash("sha256").update(body).digest("hex"),
    })),
  };
  await NodeFSP.writeFile(NodePath.join(directory, MANIFEST_FILE), JSON.stringify(manifest));
  return { directory, manifest };
}

const FILES = {
  "statev2.sqlite": Buffer.concat([
    Buffer.from("SQLite format 3\0"),
    NodeCrypto.randomBytes(20_000),
  ]),
  "settings.json": Buffer.from('{"theme":"dark"}'),
  "keybindings.json": Buffer.from("[]"),
  "attachments/thread-1/a.png": NodeCrypto.randomBytes(9_000),
};

async function sealed(passphrase = "a long passphrase") {
  const snapshot = await makeSnapshot(FILES);
  const destination = NodePath.join(
    snapshot.directory,
    "..",
    `${NodePath.basename(snapshot.directory)}.p0bak`,
  );
  temporary.push(destination);
  const result = await sealSnapshot({ ...snapshot, destination, passphrase, encryption: FAST });
  return { ...snapshot, file: destination, result };
}

const restoreDir = () => {
  const directory = NodePath.join(NodeOS.tmpdir(), `p0bak-restore-${NodeCrypto.randomUUID()}`);
  temporary.push(directory);
  return directory;
};

describe("backup file", () => {
  it("round-trips a snapshot", async () => {
    const { file, manifest, result } = await sealed();
    const bytes = await NodeFSP.readFile(file);
    expect(result.bytes).toBe(bytes.length);
    expect(result.sha256).toBe(NodeCrypto.createHash("sha256").update(bytes).digest("hex"));
    // The remote sees no plaintext.
    expect(bytes.includes(Buffer.from("SQLite format 3"))).toBe(false);
    expect(bytes.includes(Buffer.from("theme"))).toBe(false);

    const directory = restoreDir();
    expect(await openBackup({ file, directory, passphrase: "a long passphrase" })).toEqual(
      manifest,
    );
    for (const [path, body] of Object.entries(FILES)) {
      expect(await NodeFSP.readFile(NodePath.join(directory, path))).toEqual(body);
    }
  });

  it("rejects a wrong passphrase", async () => {
    const { file } = await sealed();
    await expect(
      openBackup({ file, directory: restoreDir(), passphrase: "not the passphrase" }),
    ).rejects.toThrow(BackupDecryptError);
  });

  it("rejects a tampered or cut backup", async () => {
    const { file } = await sealed();
    const bytes = await NodeFSP.readFile(file);
    bytes[bytes.length - 40]! ^= 0xff;
    await NodeFSP.writeFile(file, bytes);
    await expect(
      openBackup({ file, directory: restoreDir(), passphrase: "a long passphrase" }),
    ).rejects.toThrow(/damaged/);
    await NodeFSP.writeFile(file, bytes.subarray(0, 37 + 4096 + 16));
    await expect(
      openBackup({ file, directory: restoreDir(), passphrase: "a long passphrase" }),
    ).rejects.toThrow(BackupDecryptError);
  });

  it("rejects a snapshot that does not match its manifest", async () => {
    const snapshot = await makeSnapshot(FILES);
    await NodeFSP.writeFile(NodePath.join(snapshot.directory, "settings.json"), "{}");
    const destination = `${snapshot.directory}.p0bak`;
    temporary.push(destination);
    await sealSnapshot({
      ...snapshot,
      destination,
      passphrase: "a long passphrase",
      encryption: FAST,
    });
    await expect(
      openBackup({ file: destination, directory: restoreDir(), passphrase: "a long passphrase" }),
    ).rejects.toThrow(SnapshotError);
  });
});
