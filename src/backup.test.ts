// @effect-diagnostics nodeBuiltinImport:off -- Runs a fake S3 server and writes fake snapshots on disk.
// @effect-diagnostics globalDate:off -- Parses the fixed x-amz-date format the fake server receives.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { PluginContext, type PendingRestore } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeBackupService } from "./backup.ts";
import { backupName } from "./backups.ts";
import { signV4 } from "./sigv4.ts";
import { MANIFEST_FILE } from "./snapshot.ts";

const CREDENTIALS = { accessKeyId: "test-key", secretAccessKey: "test-secret-do-not-leak" };
const PASSPHRASE = "a passphrase only the test knows";
// The host brands environment ids (@t3tools/contracts); the tests need the brand, not the package.
const EnvironmentId = Schema.String.pipe(Schema.brand("EnvironmentId"));
const ENVIRONMENT = "env-test";
const FILES: Record<string, Buffer> = {
  "statev2.sqlite": Buffer.concat([
    Buffer.from("SQLite format 3\0"),
    NodeCrypto.randomBytes(50_000),
  ]),
  "settings.json": Buffer.from('{"theme":"dark"}'),
  "keybindings.json": Buffer.from("[]"),
  "attachments/thread-1/image.png": NodeCrypto.randomBytes(20_000),
};

/** Enough of S3 to back up to: path-style PUT, GET, DELETE and ListObjectsV2, with SigV4 checked. */
function startFakeS3() {
  const objects = new Map<string, Buffer>();
  const server = NodeHttp.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const payloadHash = String(request.headers["x-amz-content-sha256"]);
      const stamp = String(request.headers["x-amz-date"]);
      const expected = signV4({
        method: request.method ?? "GET",
        url,
        headers: { "x-amz-content-sha256": payloadHash },
        payloadHash,
        region: "us-east-1",
        service: "s3",
        credentials: CREDENTIALS,
        now: Date.parse(
          stamp.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z"),
        ),
      });
      const reply = (status: number, text = "") => {
        response.writeHead(status, { "content-type": "application/xml" });
        response.end(text);
      };
      if (request.headers.authorization !== expected.headers.authorization) {
        return reply(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>");
      }
      const [, bucket, ...rest] = url.pathname.split("/");
      if (bucket !== "bk") return reply(404, "<Error><Code>NoSuchBucket</Code></Error>");
      const key = rest.map(decodeURIComponent).join("/");
      if (request.method === "PUT") {
        if (NodeCrypto.createHash("sha256").update(body).digest("hex") !== payloadHash) {
          return reply(400, "<Error><Code>XAmzContentSHA256Mismatch</Code></Error>");
        }
        objects.set(key, body);
        return reply(200);
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return reply(204);
      }
      if (key === "" && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const contents = [...objects]
          .filter(([name]) => name.startsWith(prefix))
          .map(
            ([name, data]) => `<Contents><Key>${name}</Key><Size>${data.length}</Size></Contents>`,
          )
          .join("");
        return reply(
          200,
          `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
        );
      }
      const found = objects.get(key);
      if (found === undefined) return reply(404, "<Error><Code>NoSuchKey</Code></Error>");
      response.writeHead(200, { "content-length": found.length });
      response.end(found);
    });
  });
  return { objects, server };
}

const s3 = startFakeS3();
let root: string;
let endpoint: string;
beforeAll(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "p0bak-service-"));
  await new Promise<void>((resolve) => s3.server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  s3.server.close();
  await NodeFSP.rm(root, { recursive: true });
});

/** The host side as docs/HOST_API.md proposes it, over temporary folders. */
function fakeHost() {
  const storage = new Map<string, string>();
  const statusLines: Array<string | null> = [];
  let pending: PendingRestore | null = null;
  let stagedDirectory: string | null = null;

  const writeSnapshot = async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(root, "snapshot-"));
    for (const [path, body] of Object.entries(FILES)) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(directory, path)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(directory, path), body);
    }
    const manifest = {
      format: 1 as const,
      createdAt: "2026-11-25T00:00:00.000Z",
      environmentId: ENVIRONMENT,
      appVersion: "0.0.0-test",
      migrationHead: 119,
      files: Object.entries(FILES).map(([path, body]) => ({
        path,
        bytes: body.length,
        sha256: NodeCrypto.createHash("sha256").update(body).digest("hex"),
      })),
    };
    await NodeFSP.writeFile(NodePath.join(directory, MANIFEST_FILE), JSON.stringify(manifest));
    return { directory, manifest };
  };

  const context = PluginContext.of({
    pluginId: "backup",
    dataDir: NodePath.join(root, "plugin-data"),
    storage: {
      get: (key) => Effect.sync(() => Option.fromUndefinedOr(storage.get(key))),
      set: (key, value) => Effect.sync(() => void storage.set(key, value)),
      remove: (key) => Effect.sync(() => void storage.delete(key)),
    },
    reportStatus: (message) => Effect.sync(() => void statusLines.push(message)),
    environment: {
      environmentId: Effect.succeed(EnvironmentId.make(ENVIRONMENT)),
      descriptor: Effect.die("unused"),
      localOrigin: Effect.die("unused"),
    },
    deviceAccess: { issueCredential: () => Effect.die("unused"), revokeAll: Effect.die("unused") },
    agentActivity: {
      changes: Stream.empty,
      read: () => Effect.die("unused"),
      activeThreadIds: Effect.die("unused"),
    },
    usage: { dailyTotals: () => Effect.die("unused") },
    dataBackup: {
      snapshot: Effect.acquireRelease(Effect.promise(writeSnapshot), ({ directory }) =>
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
      ),
      stageRestore: (directory) =>
        Effect.promise(async () => {
          stagedDirectory = NodePath.join(root, `staged-${NodeCrypto.randomUUID()}`);
          await NodeFSP.rename(directory, stagedDirectory);
          pending = {
            id: "restore-1",
            stagedAt: "2026-11-25T00:00:00.000Z",
            snapshotCreatedAt: "2026-11-25T00:00:00.000Z",
            sourceEnvironmentId: ENVIRONMENT,
            files: Object.keys(FILES).length,
            bytes: 0,
          };
          return pending;
        }),
      pendingRestore: Effect.sync(() => pending),
      cancelRestore: Effect.sync(() => void (pending = null)),
    },
  });
  return { context, storage, statusLines, staged: () => stagedDirectory };
}

const platform = Layer.mergeAll(NodeServices.layer, PlatformCrypto.layer, FetchHttpClient.layer);

const run = <A, E>(
  host: ReturnType<typeof fakeHost>,
  body: (service: Effect.Success<ReturnType<typeof makeBackupService>>) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    makeBackupService().pipe(
      Effect.flatMap(body),
      Effect.scoped,
      Effect.provideService(PluginContext, host.context),
      Effect.provide(platform),
    ),
  );

type Service = Effect.Success<ReturnType<typeof makeBackupService>>;
const settled = (service: Service) =>
  Effect.gen(function* () {
    while (true) {
      const status = yield* service.status;
      if (status.activity === null) return status;
      yield* Effect.sleep("20 millis");
    }
  });

describe("backup service against S3", () => {
  it("backs up, prunes, lists, verifies and stages a restore", async () => {
    const host = fakeHost();
    const old = (iso: string, environment = ENVIRONMENT) =>
      `p0/${backupName(environment, Date.parse(iso))}`;
    for (const key of [
      old("2026-01-01T00:00:00Z"),
      old("2026-01-02T00:00:00Z"),
      old("2026-01-03T00:00:00Z"),
      old("2025-01-01T00:00:00Z", "env-other"),
    ]) {
      s3.objects.set(key, Buffer.from("old"));
    }

    await run(host, (service) =>
      Effect.gen(function* () {
        const refused = yield* service.backupNow.pipe(Effect.flip);
        expect(refused.message).toBe("Choose where backups go first.");

        yield* service.setSettings({
          target: "s3",
          frequency: "off",
          keep: 2,
          s3: {
            endpoint,
            region: "us-east-1",
            bucket: "bk",
            prefix: "p0/",
            forcePathStyle: true,
            accessKeyId: CREDENTIALS.accessKeyId,
            secretAccessKey: CREDENTIALS.secretAccessKey,
          },
          passphrase: PASSPHRASE,
        });

        const running = yield* service.backupNow;
        expect(running.activity?.kind).toBe("backup");
        const done = yield* settled(service);
        expect(done.lastResult).toMatchObject({ kind: "backup", ok: true });
        expect(done.lastResult?.message).toMatch(/removed 2 old/);
        const name = done.lastBackup!.name;

        // Secrets never come back out.
        const shown = JSON.stringify(done);
        expect(shown).not.toContain(CREDENTIALS.secretAccessKey);
        expect(shown).not.toContain(PASSPHRASE);
        expect(done.stored).toMatchObject({ passphrase: true, s3SecretAccessKey: true });

        // Only ciphertext reaches the bucket.
        const stored = s3.objects.get(`p0/${name}`)!;
        expect(stored.subarray(0, 5).toString()).toBe("P0BAK");
        expect(stored.includes(Buffer.from("SQLite format 3"))).toBe(false);

        const { backups } = yield* service.list;
        expect(backups.map((backup) => [backup.environmentId, backup.mine])).toEqual([
          [ENVIRONMENT, true],
          [ENVIRONMENT, true],
          ["env-other", false],
        ]);
        expect(backups[0]!.name).toBe(name);

        yield* service.verify({ name });
        expect((yield* settled(service)).lastResult).toMatchObject({ kind: "verify", ok: true });

        yield* service.verify({ name, passphrase: "the wrong passphrase" });
        expect((yield* settled(service)).lastResult).toMatchObject({
          kind: "verify",
          ok: false,
          message: "Wrong passphrase, or the backup is damaged.",
        });

        yield* service.restore({ name });
        const restored = yield* settled(service);
        expect(restored.lastResult).toMatchObject({ kind: "restore", ok: true });
        expect(restored.pendingRestore?.id).toBe("restore-1");
        for (const [path, body] of Object.entries(FILES)) {
          const copy = yield* Effect.promise(() =>
            NodeFSP.readFile(NodePath.join(host.staged()!, path)),
          );
          expect(copy.equals(body)).toBe(true);
        }

        yield* service.cancelRestore;
        expect((yield* service.status).pendingRestore).toBeNull();

        // Anything changed on the remote is caught.
        const tampered = Buffer.from(stored);
        tampered[tampered.length - 100]! ^= 1;
        s3.objects.set(`p0/${name}`, tampered);
        yield* service.verify({ name });
        expect((yield* settled(service)).lastResult).toMatchObject({ kind: "verify", ok: false });
      }),
    );
    expect(host.statusLines.at(-1)).toBeTruthy();
  }, 30_000);

  it("reports a bad secret from the storage service", async () => {
    const host = fakeHost();
    await run(host, (service) =>
      Effect.gen(function* () {
        yield* service.setSettings({
          target: "s3",
          frequency: "off",
          s3: {
            endpoint,
            bucket: "bk",
            forcePathStyle: true,
            accessKeyId: CREDENTIALS.accessKeyId,
            secretAccessKey: "wrong",
          },
          passphrase: PASSPHRASE,
        });
        const error = yield* service.list.pipe(Effect.flip);
        expect(error.message).toMatch(/403 SignatureDoesNotMatch/);
      }),
    );
  });
});
