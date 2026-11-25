// @effect-diagnostics nodeBuiltinImport:off -- Streams whole backups through node:crypto, zlib and fs; Effect's crypto has no streaming AES-GCM or scrypt.
// A minimal POSIX (pax) tar writer and reader: regular files and directories only.
// Backups are plain tar inside gzip inside the encryption, so a decrypted backup
// opens with any tar tool.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { Readable } from "node:stream";

import * as Schema from "effect/Schema";

import { BufferQueue } from "./bufferQueue.ts";

const BLOCK = 512;
const USTAR_MAX_SIZE = 0o77777777777;
const ZERO_BLOCK = Buffer.alloc(BLOCK);

export class ArchiveError extends Schema.TaggedError<ArchiveError>()("ArchiveError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

/** A relative path with `/` separators that cannot leave the directory it is unpacked into. */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function writeOctal(block: Buffer, offset: number, width: number, value: number): void {
  block.write(value.toString(8).padStart(width - 1, "0") + "\0", offset, width, "ascii");
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  // The length prefix counts itself, so grow it until it is stable.
  let length = Buffer.byteLength(body);
  while (String(length).length + Buffer.byteLength(body) !== length) {
    length = String(length).length + Buffer.byteLength(body);
  }
  return `${length}${body}`;
}

function header(name: string, size: number, type: "0" | "5" | "x", mode: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  writeOctal(block, 100, 8, mode);
  writeOctal(block, 108, 8, 0);
  writeOctal(block, 116, 8, 0);
  writeOctal(block, 124, 12, size);
  writeOctal(block, 136, 12, 0);
  block.fill(" ", 148, 156);
  block.write(type, 156, 1, "ascii");
  block.write("ustar\0" + "00", 257, 8, "ascii");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return block;
}

function padding(size: number): Buffer {
  const rest = size % BLOCK;
  return rest === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rest);
}

function* entryHeaders(path: string, size: number, type: "0" | "5"): Generator<Buffer> {
  const records =
    (Buffer.byteLength(path) > 100 ? paxRecord("path", path) : "") +
    (size > USTAR_MAX_SIZE ? paxRecord("size", String(size)) : "");
  if (records.length > 0) {
    const body = Buffer.from(records, "utf8");
    yield header("PaxHeader", body.length, "x", 0o644);
    yield body;
    yield padding(body.length);
  }
  yield header(
    Buffer.byteLength(path) > 100 ? path.slice(-100) : path,
    size > USTAR_MAX_SIZE ? 0 : size,
    type,
    type === "5" ? 0o755 : 0o644,
  );
}

/**
 * Streams a tar of the given files under `root`, in order. Parent directories are
 * implied by the paths. A file whose size changes while it is read fails the stream:
 * the input is meant to be an immutable snapshot.
 */
export function packFiles(root: string, paths: ReadonlyArray<string>): Readable {
  async function* generate(): AsyncGenerator<Buffer> {
    for (const path of paths) {
      if (!isSafeRelativePath(path))
        throw new ArchiveError({ detail: `Refusing to pack ${path}.` });
      const absolute = NodePath.join(root, ...path.split("/"));
      const info = await NodeFSP.lstat(absolute);
      if (!info.isFile()) throw new ArchiveError({ detail: `${path} is not a regular file.` });
      yield* entryHeaders(path, info.size, "0");
      let read = 0;
      for await (const chunk of NodeFS.createReadStream(absolute)) {
        read += (chunk as Buffer).length;
        if (read > info.size) break;
        yield chunk as Buffer;
      }
      if (read !== info.size)
        throw new ArchiveError({ detail: `${path} changed while it was archived.` });
      yield padding(info.size);
    }
    yield ZERO_BLOCK;
    yield ZERO_BLOCK;
  }
  return Readable.from(generate(), { objectMode: false });
}

function readString(block: Buffer, offset: number, width: number): string {
  const field = block.subarray(offset, offset + width);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? width : end).toString("utf8");
}

function readOctal(block: Buffer, offset: number, width: number): number {
  const text = readString(block, offset, width).trim();
  if (!/^[0-7]*$/.test(text))
    throw new ArchiveError({ detail: "The archive has a malformed header." });
  return text === "" ? 0 : Number.parseInt(text, 8);
}

function checksumMatches(block: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  }
  return sum === readOctal(block, 148, 8);
}

function parsePax(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    const length = Number.parseInt(body.subarray(offset, space).toString("ascii"), 10);
    if (space === -1 || !Number.isSafeInteger(length) || length <= 0) {
      throw new ArchiveError({ detail: "The archive has a malformed extended header." });
    }
    const record = body.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    records.set(record.slice(0, equals), record.slice(equals + 1));
    offset += length;
  }
  return records;
}

/**
 * Unpacks a tar stream into `root`, which must exist and be empty. Only regular files
 * and directories with safe relative paths are accepted. Returns the files written.
 */
export async function unpackTo(source: AsyncIterable<Buffer>, root: string): Promise<string[]> {
  const queue = new BufferQueue();
  const iterator = source[Symbol.asyncIterator]();
  const fill = async (size: number) => {
    while (queue.length < size) {
      const next = await iterator.next();
      if (next.done) throw new ArchiveError({ detail: "The archive ended early." });
      queue.push(next.value);
    }
  };
  const take = async (size: number) => {
    await fill(size);
    return queue.take(size);
  };
  const written: string[] = [];
  let pax = new Map<string, string>();

  while (true) {
    const block = await take(BLOCK);
    if (block.equals(ZERO_BLOCK)) {
      await take(BLOCK);
      return written;
    }
    if (!checksumMatches(block))
      throw new ArchiveError({ detail: "The archive has a damaged header." });
    const type = String.fromCharCode(block[156]!);
    const size = Number(pax.get("size") ?? readOctal(block, 124, 12));
    if (!Number.isSafeInteger(size) || size < 0)
      throw new ArchiveError({ detail: "Bad entry size." });
    const prefix = readString(block, 345, 155);
    const path = pax.get("path") ?? (prefix ? `${prefix}/` : "") + readString(block, 0, 100);
    const padded = size + padding(size).length;

    if (type === "x") {
      pax = parsePax((await take(padded)).subarray(0, size));
      continue;
    }
    pax = new Map();
    const cleanPath = path.replace(/\/$/, "");
    if (!isSafeRelativePath(cleanPath))
      throw new ArchiveError({ detail: `Unsafe path ${path} in archive.` });
    const absolute = NodePath.join(root, ...cleanPath.split("/"));

    if (type === "5") {
      await NodeFSP.mkdir(absolute, { recursive: true });
      await take(padded);
      continue;
    }
    if (type !== "0" && type !== "\0") {
      throw new ArchiveError({ detail: `Unsupported entry type for ${path}.` });
    }
    await NodeFSP.mkdir(NodePath.dirname(absolute), { recursive: true });
    const file = await NodeFSP.open(absolute, "wx", 0o600);
    try {
      let left = size;
      while (left > 0) {
        if (queue.length === 0) await fill(1);
        const piece = queue.take(Math.min(left, queue.length));
        await file.write(piece);
        left -= piece.length;
      }
    } finally {
      await file.close();
    }
    await take(padded - size);
    written.push(cleanPath);
  }
}
