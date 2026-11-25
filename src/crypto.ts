// @effect-diagnostics nodeBuiltinImport:off -- Streams whole backups through node:crypto, zlib and fs; Effect's crypto has no streaming AES-GCM or scrypt.
// Client-side encryption for backups: the remote only ever stores what this file writes.
//
// File layout (format 1), all integers big-endian:
//
//   offset  size  field
//        0     5  magic "P0BAK"
//        5     1  format version (1)
//        6     1  key derivation (1 = scrypt)
//        7     1  scrypt log2(N)
//        8     1  scrypt r
//        9     1  scrypt p
//       10    16  salt
//       26     7  nonce prefix
//       33     4  plaintext bytes per chunk
//       37     …  chunks: AES-256-GCM ciphertext followed by its 16-byte tag
//
// The key is scrypt(passphrase in NFC, salt). Chunk i uses the 12-byte nonce
// prefix ‖ i (4 bytes) ‖ last (1 byte, 1 only on the final chunk), and the whole
// header as additional data, so a changed header, reordered, dropped or appended
// chunk, or a cut at a chunk boundary all fail authentication (the STREAM
// construction of Hoang, Reyhanitabar, Rogaway and Vizár). Every chunk but the
// last holds exactly `chunk bytes` of plaintext; the last holds the rest (empty
// only for an empty input).
import * as NodeCrypto from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

import * as Schema from "effect/Schema";

import { BufferQueue } from "./bufferQueue.ts";

const MAGIC = Buffer.from("P0BAK", "ascii");
export const FORMAT_VERSION = 1;
const KDF_SCRYPT = 1;
const SALT_BYTES = 16;
const NONCE_PREFIX_BYTES = 7;
const TAG_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + 5 + SALT_BYTES + NONCE_PREFIX_BYTES + 4;
export const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_CHUNKS = 2 ** 32;

export interface ScryptParams {
  readonly log2N: number;
  readonly r: number;
  readonly p: number;
}

/** About 128 MiB and a fraction of a second per backup on a laptop. */
export const DEFAULT_SCRYPT: ScryptParams = { log2N: 17, r: 8, p: 1 };
/** A header asking for more than this is refused rather than allowed to exhaust memory. */
const SCRYPT_LIMITS: ScryptParams = { log2N: 20, r: 16, p: 4 };

export const DecryptFailure = Schema.Literals([
  "not-a-backup",
  "unsupported-version",
  "unsafe-parameters",
  "wrong-passphrase-or-damaged",
  "damaged",
  "truncated",
]);
export type DecryptFailure = typeof DecryptFailure.Type;

const FAILURE_MESSAGES: Record<DecryptFailure, string> = {
  "not-a-backup": "This file is not a p0code backup.",
  "unsupported-version": "This backup was made by a newer version of the plugin.",
  "unsafe-parameters": "This backup asks for unsafe decryption parameters.",
  "wrong-passphrase-or-damaged": "Wrong passphrase, or the backup is damaged.",
  damaged: "The backup is damaged or was changed after it was made.",
  truncated: "The backup is incomplete.",
};

export class BackupDecryptError extends Schema.TaggedError<BackupDecryptError>()(
  "BackupDecryptError",
  { reason: DecryptFailure },
) {
  override get message(): string {
    return FAILURE_MESSAGES[this.reason];
  }
}

interface Header {
  readonly bytes: Buffer;
  readonly scrypt: ScryptParams;
  readonly salt: Buffer;
  readonly noncePrefix: Buffer;
  readonly chunkBytes: number;
}

function encodeHeader(scrypt: ScryptParams, chunkBytes: number): Header {
  const salt = NodeCrypto.randomBytes(SALT_BYTES);
  const noncePrefix = NodeCrypto.randomBytes(NONCE_PREFIX_BYTES);
  const bytes = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(bytes, 0);
  bytes.writeUInt8(FORMAT_VERSION, 5);
  bytes.writeUInt8(KDF_SCRYPT, 6);
  bytes.writeUInt8(scrypt.log2N, 7);
  bytes.writeUInt8(scrypt.r, 8);
  bytes.writeUInt8(scrypt.p, 9);
  salt.copy(bytes, 10);
  noncePrefix.copy(bytes, 26);
  bytes.writeUInt32BE(chunkBytes, 33);
  return { bytes, scrypt, salt, noncePrefix, chunkBytes };
}

function decodeHeader(bytes: Buffer): Header {
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC))
    throw new BackupDecryptError({ reason: "not-a-backup" });
  if (bytes.readUInt8(5) !== FORMAT_VERSION || bytes.readUInt8(6) !== KDF_SCRYPT) {
    throw new BackupDecryptError({ reason: "unsupported-version" });
  }
  const scrypt = { log2N: bytes.readUInt8(7), r: bytes.readUInt8(8), p: bytes.readUInt8(9) };
  const chunkBytes = bytes.readUInt32BE(33);
  if (
    scrypt.log2N < 1 ||
    scrypt.log2N > SCRYPT_LIMITS.log2N ||
    scrypt.r < 1 ||
    scrypt.r > SCRYPT_LIMITS.r ||
    scrypt.p < 1 ||
    scrypt.p > SCRYPT_LIMITS.p ||
    chunkBytes < 1 ||
    chunkBytes > MAX_CHUNK_BYTES
  ) {
    throw new BackupDecryptError({ reason: "unsafe-parameters" });
  }
  return {
    bytes,
    scrypt,
    salt: bytes.subarray(10, 26),
    noncePrefix: bytes.subarray(26, 33),
    chunkBytes,
  };
}

export function deriveKey(passphrase: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.log2N;
  return new Promise((resolve, reject) => {
    NodeCrypto.scrypt(
      Buffer.from(passphrase.normalize("NFC"), "utf8"),
      salt,
      32,
      { N, r: params.r, p: params.p, maxmem: 256 * N * params.r + 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function nonce(prefix: Buffer, index: number, last: boolean): Buffer {
  if (index >= MAX_CHUNKS) throw new RangeError("Too many chunks for one backup.");
  const out = Buffer.alloc(12);
  prefix.copy(out, 0);
  out.writeUInt32BE(index, NONCE_PREFIX_BYTES);
  out.writeUInt8(last ? 1 : 0, 11);
  return out;
}

class Encryptor extends Transform {
  private readonly queue = new BufferQueue();
  private index = 0;
  private headerSent = false;
  private readonly key: Buffer;
  private readonly header: Header;

  constructor(key: Buffer, header: Header) {
    super();
    this.key = key;
    this.header = header;
  }

  private seal(plaintext: Buffer, last: boolean): void {
    if (!this.headerSent) {
      this.push(this.header.bytes);
      this.headerSent = true;
    }
    const cipher = NodeCrypto.createCipheriv(
      "aes-256-gcm",
      this.key,
      nonce(this.header.noncePrefix, this.index++, last),
    );
    cipher.setAAD(this.header.bytes);
    this.push(Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]));
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.queue.push(chunk);
      // Strictly more than a chunk: the final chunk is sealed in _flush, once it is known to be last.
      while (this.queue.length > this.header.chunkBytes) {
        this.seal(this.queue.take(this.header.chunkBytes), false);
      }
      done();
    } catch (error) {
      done(error as Error);
    }
  }

  override _flush(done: TransformCallback): void {
    try {
      this.seal(this.queue.take(this.queue.length), true);
      done();
    } catch (error) {
      done(error as Error);
    }
  }
}

export interface EncryptOptions {
  readonly scrypt?: ScryptParams;
  readonly chunkBytes?: number;
}

/** Derives a fresh key (new salt every time), then returns the encrypting stream. */
export async function createEncryptStream(
  passphrase: string,
  options: EncryptOptions = {},
): Promise<Transform> {
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (chunkBytes < 1 || chunkBytes > MAX_CHUNK_BYTES) throw new RangeError("Bad chunk size.");
  const header = encodeHeader(options.scrypt ?? DEFAULT_SCRYPT, chunkBytes);
  return new Encryptor(await deriveKey(passphrase, header.salt, header.scrypt), header);
}

class Decryptor extends Transform {
  private readonly queue = new BufferQueue();
  private header: Header | null = null;
  private key: Buffer | null = null;
  private index = 0;
  private readonly passphrase: string;

  constructor(passphrase: string) {
    super();
    this.passphrase = passphrase;
  }

  private open(ciphertext: Buffer, last: boolean): void {
    const { header, key } = this;
    if (header === null || key === null) throw new Error("Decryptor used before its key.");
    const decipher = NodeCrypto.createDecipheriv(
      "aes-256-gcm",
      key,
      nonce(header.noncePrefix, this.index, last),
    );
    decipher.setAAD(header.bytes);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
    try {
      const plaintext = Buffer.concat([
        decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
        decipher.final(),
      ]);
      this.index++;
      this.push(plaintext);
    } catch {
      // The first chunk is the passphrase check; after it, the key is known to be right.
      throw new BackupDecryptError({
        reason: this.index === 0 ? "wrong-passphrase-or-damaged" : "damaged",
      });
    }
  }

  private drain(): void {
    const frame = this.header!.chunkBytes + TAG_BYTES;
    while (this.queue.length > frame) this.open(this.queue.take(frame), false);
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.queue.push(chunk);
    if (this.key !== null) {
      try {
        this.drain();
        done();
      } catch (error) {
        done(error as Error);
      }
      return;
    }
    if (this.queue.length < HEADER_BYTES) return done();
    let header: Header;
    try {
      header = decodeHeader(this.queue.take(HEADER_BYTES));
    } catch (error) {
      return done(error as Error);
    }
    this.header = header;
    deriveKey(this.passphrase, header.salt, header.scrypt).then(
      (key) => {
        this.key = key;
        try {
          this.drain();
          done();
        } catch (error) {
          done(error as Error);
        }
      },
      (error: unknown) => done(error as Error),
    );
  }

  override _flush(done: TransformCallback): void {
    try {
      if (this.header === null || this.queue.length < TAG_BYTES) {
        throw new BackupDecryptError({
          reason: this.header === null ? "not-a-backup" : "truncated",
        });
      }
      this.open(this.queue.take(this.queue.length), true);
      done();
    } catch (error) {
      done(error as Error);
    }
  }
}

/** Fails with a BackupDecryptError on a wrong passphrase or any change to the file. */
export function createDecryptStream(passphrase: string): Transform {
  return new Decryptor(passphrase);
}

/** Passes bytes through, counting them and hashing them with SHA-256. */
export function createDigestStream(): Transform & {
  readonly result: () => { readonly bytes: number; readonly sha256: string };
} {
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  let digest: string | null = null;
  const stream = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  return Object.assign(stream, {
    result: () => {
      digest ??= hash.digest("hex");
      return { bytes, sha256: digest };
    },
  });
}
