// @effect-diagnostics nodeBuiltinImport:off -- Streams whole backups through node:crypto, zlib and fs; Effect's crypto has no streaming AES-GCM or scrypt.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { pipeline } from "node:stream/promises";

import { DataSnapshotManifest } from "@t3tools/plugin-api";
import * as Schema from "effect/Schema";

import { isSafeRelativePath } from "./archive.ts";

export const MANIFEST_FILE = "manifest.json";
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(DataSnapshotManifest));

export class SnapshotError extends Schema.TaggedError<SnapshotError>()("SnapshotError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

/** What goes into the archive, manifest first so a reader learns the contents early. */
export const archivedPaths = (manifest: DataSnapshotManifest): string[] => [
  MANIFEST_FILE,
  ...manifest.files.map((file) => file.path),
];

async function sha256File(path: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  await pipeline(NodeFS.createReadStream(path), hash);
  return hash.digest("hex");
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await NodeFSP.readdir(NodePath.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(root, relative)));
    else out.push(relative);
  }
  return out;
}

/**
 * Checks an unpacked snapshot against its manifest: every listed file present with its
 * size and SHA-256, nothing unlisted, and a database included. The host checks again
 * when it stages the restore; this lets `verify` answer without involving the host.
 */
export async function verifySnapshot(directory: string): Promise<DataSnapshotManifest> {
  let manifest: DataSnapshotManifest;
  try {
    manifest = decodeManifest(
      await NodeFSP.readFile(NodePath.join(directory, MANIFEST_FILE), "utf8"),
    );
  } catch (cause) {
    throw new SnapshotError({ detail: "The backup has no readable manifest.", cause });
  }
  if (!manifest.files.some((file) => file.path === "statev2.sqlite")) {
    throw new SnapshotError({ detail: "The backup has no database." });
  }
  const listed = new Set(archivedPaths(manifest));
  for (const path of await listFiles(directory)) {
    if (!listed.has(path))
      throw new SnapshotError({ detail: `The backup has an unlisted file: ${path}.` });
  }
  for (const file of manifest.files) {
    if (!isSafeRelativePath(file.path))
      throw new SnapshotError({ detail: `Unsafe path ${file.path}.` });
    const absolute = NodePath.join(directory, ...file.path.split("/"));
    const info = await NodeFSP.stat(absolute).catch(() => null);
    if (info === null || info.size !== file.bytes || (await sha256File(absolute)) !== file.sha256) {
      throw new SnapshotError({ detail: `${file.path} does not match the manifest.` });
    }
  }
  return manifest;
}
