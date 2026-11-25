// @effect-diagnostics nodeBuiltinImport:off -- Builds real files and streams on disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { isSafeRelativePath, packFiles, unpackTo } from "./archive.ts";

const temporary: string[] = [];
const makeDir = async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p0bak-archive-"));
  temporary.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true })));
});

async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part as Buffer);
  return Buffer.concat(parts);
}

describe("tar", () => {
  it("round-trips files, nested folders and long names", async () => {
    const source = await makeDir();
    const longName = `attachments/${"thread-".repeat(20)}/image.png`;
    const files: Record<string, Buffer> = {
      "manifest.json": Buffer.from("{}"),
      "statev2.sqlite": NodeCrypto.randomBytes(5000),
      "settings.json": Buffer.alloc(0),
      [longName]: NodeCrypto.randomBytes(512),
    };
    for (const [path, body] of Object.entries(files)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(source, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(source, path), body);
    }
    const tar = await collect(packFiles(source, Object.keys(files)));
    expect(tar.length % 512).toBe(0);

    const target = await makeDir();
    const written = await unpackTo(Readable.from([tar]), target);
    expect(written).toEqual(Object.keys(files));
    for (const [path, body] of Object.entries(files)) {
      expect(await NodeFSP.readFile(NodePath.join(target, path))).toEqual(body);
    }
  });

  it("refuses unsafe paths", () => {
    for (const path of ["../x", "/etc/passwd", "a/../../b", "a//b", "a\\b", ""]) {
      expect(isSafeRelativePath(path)).toBe(false);
    }
    expect(isSafeRelativePath("attachments/a/b.png")).toBe(true);
  });

  it("refuses an archive that escapes its folder", async () => {
    const header = Buffer.alloc(512);
    header.write("../escape", 0, "utf8");
    header.write("0000644\0", 100, "ascii");
    header.write("00000000000\0", 124, "ascii");
    header.fill(" ", 148, 156);
    header.write("0", 156, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    const target = await makeDir();
    await expect(unpackTo(Readable.from([header, Buffer.alloc(1024)]), target)).rejects.toThrow(
      /Unsafe path/,
    );
  });

  it("refuses a damaged or cut archive", async () => {
    const source = await makeDir();
    await NodeFSP.writeFile(NodePath.join(source, "a"), "hello");
    const tar = await collect(packFiles(source, ["a"]));
    const damaged = Buffer.from(tar);
    damaged[0] = 0x62;
    await expect(unpackTo(Readable.from([damaged]), await makeDir())).rejects.toThrow(/damaged/);
    await expect(unpackTo(Readable.from([tar.subarray(0, 600)]), await makeDir())).rejects.toThrow(
      /ended early/,
    );
  });
});
