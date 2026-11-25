// @effect-diagnostics nodeBuiltinImport:off -- Builds real files and streams on disk.
import * as NodeCrypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  BackupDecryptError,
  createDecryptStream,
  createEncryptStream,
  HEADER_BYTES,
  type EncryptOptions,
} from "./crypto.ts";

// Small parameters keep the suite fast; the header carries them, so decryption needs no options.
const FAST: EncryptOptions = { scrypt: { log2N: 10, r: 8, p: 1 }, chunkBytes: 64 };
const PASSPHRASE = "correct horse battery staple";
const isDecryptError = Schema.is(BackupDecryptError);

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
}

/** Feeds `input` in uneven pieces to exercise buffering across chunk boundaries. */
function pieces(input: Buffer): Readable {
  const out: Buffer[] = [];
  for (
    let offset = 0, size = 1;
    offset < input.length;
    offset += size, size = ((size * 7) % 97) + 1
  ) {
    out.push(input.subarray(offset, offset + size));
  }
  return Readable.from(out);
}

async function encrypt(plaintext: Buffer, options: EncryptOptions = FAST): Promise<Buffer> {
  const encryptor = await createEncryptStream(PASSPHRASE, options);
  return collect(pieces(plaintext).pipe(encryptor));
}

async function decrypt(ciphertext: Buffer, passphrase = PASSPHRASE): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(pieces(ciphertext), createDecryptStream(passphrase), async (source) => {
    for await (const part of source) out.push(part as Buffer);
  });
  return Buffer.concat(out);
}

async function decryptFailure(ciphertext: Buffer, passphrase = PASSPHRASE) {
  try {
    await decrypt(ciphertext, passphrase);
  } catch (error) {
    if (isDecryptError(error)) return error.reason;
    throw error;
  }
  return "decrypted";
}

describe("encryption", () => {
  it.each([0, 1, 63, 64, 65, 128, 1000])("round-trips %i bytes", async (size) => {
    const plaintext = NodeCrypto.randomBytes(size);
    const ciphertext = await encrypt(plaintext);
    const chunks = Math.max(1, Math.ceil(size / 64));
    expect(ciphertext.length).toBe(HEADER_BYTES + size + chunks * 16);
    expect(await decrypt(ciphertext)).toEqual(plaintext);
  });

  it("uses a fresh salt and nonce every time", async () => {
    const plaintext = Buffer.from("same input");
    expect(await encrypt(plaintext)).not.toEqual(await encrypt(plaintext));
  });

  it("round-trips with the default parameters", async () => {
    const plaintext = NodeCrypto.randomBytes(3 * 1024 * 1024 + 5);
    const encryptor = await createEncryptStream("ünïcödé passphrase");
    const ciphertext = await collect(Readable.from([plaintext]).pipe(encryptor));
    expect(await decrypt(ciphertext, "ünïcödé passphrase")).toEqual(plaintext);
  });

  it("normalizes the passphrase to NFC", async () => {
    const ciphertext = await collect(
      Readable.from([Buffer.from("x")]).pipe(await createEncryptStream("café", FAST)),
    );
    expect(await decrypt(ciphertext, "café")).toEqual(Buffer.from("x"));
  });

  it("rejects a wrong passphrase", async () => {
    const ciphertext = await encrypt(Buffer.from("secret chats"));
    expect(await decryptFailure(ciphertext, "wrong")).toBe("wrong-passphrase-or-damaged");
  });

  describe("tamper detection", () => {
    const plaintext = NodeCrypto.randomBytes(300);
    const frame = 64 + 16;

    it("detects a flipped bit in any chunk", async () => {
      const ciphertext = await encrypt(plaintext);
      for (const offset of [HEADER_BYTES + 3, HEADER_BYTES + frame + 10, ciphertext.length - 1]) {
        const changed = Buffer.from(ciphertext);
        changed[offset]! ^= 1;
        expect(await decryptFailure(changed)).toMatch(/damaged/);
      }
    });

    it("detects a changed header", async () => {
      const ciphertext = Buffer.from(await encrypt(plaintext));
      ciphertext[30]! ^= 1; // nonce prefix
      expect(await decryptFailure(ciphertext)).toBe("wrong-passphrase-or-damaged");
    });

    it("detects a backup cut at a chunk boundary", async () => {
      const ciphertext = await encrypt(plaintext);
      expect(await decryptFailure(ciphertext.subarray(0, HEADER_BYTES + 2 * frame))).toBe(
        "damaged",
      );
    });

    it("detects a backup cut mid-chunk or inside the header", async () => {
      const ciphertext = await encrypt(plaintext);
      expect(await decryptFailure(ciphertext.subarray(0, HEADER_BYTES + 5))).toBe("truncated");
      expect(await decryptFailure(ciphertext.subarray(0, 10))).toBe("not-a-backup");
    });

    it("detects swapped chunks", async () => {
      const ciphertext = await encrypt(plaintext);
      const first = ciphertext.subarray(HEADER_BYTES, HEADER_BYTES + frame);
      const second = ciphertext.subarray(HEADER_BYTES + frame, HEADER_BYTES + 2 * frame);
      const swapped = Buffer.concat([
        ciphertext.subarray(0, HEADER_BYTES),
        second,
        first,
        ciphertext.subarray(HEADER_BYTES + 2 * frame),
      ]);
      expect(await decryptFailure(swapped)).toBe("wrong-passphrase-or-damaged");
    });

    it("detects appended data", async () => {
      const ciphertext = await encrypt(plaintext);
      const appended = Buffer.concat([
        ciphertext,
        ciphertext.subarray(HEADER_BYTES, HEADER_BYTES + frame),
      ]);
      expect(await decryptFailure(appended)).toMatch(/damaged/);
    });

    it("refuses headers that are not backups or ask for too much memory", async () => {
      const ciphertext = Buffer.from(await encrypt(plaintext));
      const notOurs = Buffer.from(ciphertext);
      notOurs.write("PKZIP", 0, "ascii");
      expect(await decryptFailure(notOurs)).toBe("not-a-backup");
      const greedy = Buffer.from(ciphertext);
      greedy[7] = 30;
      expect(await decryptFailure(greedy)).toBe("unsafe-parameters");
      const future = Buffer.from(ciphertext);
      future[5] = 2;
      expect(await decryptFailure(future)).toBe("unsupported-version");
    });
  });
});
