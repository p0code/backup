import { PluginContext, PluginError } from "@t3tools/plugin-api";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  type ActivityKind,
  BackupSettings,
  type BackupSettingsPatch,
  type BackupStatus,
  type RemoteBackup,
} from "./actions.ts";
import { ArchiveError } from "./archive.ts";
import { backupName, nameId, parseBackupName, selectForDeletion } from "./backups.ts";
import { BackupDecryptError } from "./crypto.ts";
import {
  type DeviceAuthorization,
  DriveToken,
  makeDriveRemote,
  pollDeviceToken,
  refreshIfNeeded,
  revokeToken,
  startDeviceAuthorization,
} from "./drive.ts";
import { openBackup, sealSnapshot } from "./pipeline.ts";
import type { Remote, RemoteObject } from "./remote.ts";
import { makeS3Remote } from "./s3.ts";
import { nextRunAt } from "./schedule.ts";
import { SnapshotError } from "./snapshot.ts";

const KEYS = {
  settings: "settings",
  history: "history",
  passphrase: "passphrase",
  s3Secret: "s3-secret-access-key",
  driveSecret: "drive-client-secret",
  driveToken: "drive-token",
} as const;

/** What the schedule and the status line need across restarts. */
const History = Schema.Struct({
  lastSuccessAt: Schema.NullOr(Schema.Number),
  lastAttemptAt: Schema.NullOr(Schema.Number),
  consecutiveFailures: Schema.Number,
  lastBackup: Schema.NullOr(
    Schema.Struct({ name: Schema.String, bytes: Schema.Number, at: Schema.String }),
  ),
  lastResult: Schema.NullOr(
    Schema.Struct({
      kind: Schema.Literals(["backup", "verify", "restore"]),
      ok: Schema.Boolean,
      at: Schema.String,
      message: Schema.String,
    }),
  ),
});
type History = typeof History.Type;
const EMPTY_HISTORY: History = {
  lastSuccessAt: null,
  lastAttemptAt: null,
  consecutiveFailures: 0,
  lastBackup: null,
  lastResult: null,
};

interface RuntimeState {
  readonly pendingSignIn: BackupStatus["pendingSignIn"];
  readonly signInError: string | null;
  readonly activity: BackupStatus["activity"];
}

/** Long sleeps are cut short so a machine that slept still backs up soon after waking. */
const MAX_SLEEP = Duration.minutes(5);

const isPluginError = Schema.is(PluginError);
const toPluginError = (message: string) => (cause: unknown) =>
  isPluginError(cause) ? cause : new PluginError({ message, cause });
/** These carry messages written for people; anything else gets the fallback. */
const isUserFacing = Schema.is(Schema.Union([BackupDecryptError, ArchiveError, SnapshotError]));
const fromPromise = <A>(fallback: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new PluginError({ message: isUserFacing(cause) ? cause.message : fallback, cause }),
  });

const iso = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

type Services = PluginContext | HttpClient.HttpClient | FileSystem.FileSystem | Path.Path;

export const makeBackupService = Effect.fn("backup.make")(function* () {
  const ctx = yield* PluginContext;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const services = yield* Effect.context<Services>();
  const pluginScope = yield* Effect.scope;
  const state = yield* Ref.make<RuntimeState>({
    pendingSignIn: null,
    signInError: null,
    activity: null,
  });
  const workLock = yield* Semaphore.make(1);
  const wake = yield* Queue.sliding<void>(1);
  let signInFiber: Fiber.Fiber<void> | null = null;

  // Everything here is scratch: snapshots being sealed, backups being opened.
  const workDir = path.join(ctx.dataDir, "work");
  yield* fs.remove(workDir, { recursive: true }).pipe(Effect.ignore);
  yield* fs
    .makeDirectory(workDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.mapError(toPluginError("Could not create the backup work folder.")));

  const readJson = <A, I>(key: string, schema: Schema.Codec<A, I>) =>
    ctx.storage
      .get(key)
      .pipe(Effect.map(Option.flatMap(Schema.decodeUnknownOption(Schema.fromJsonString(schema)))));
  const writeJson = <A, I>(key: string, schema: Schema.Codec<A, I>, value: A) =>
    Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
      Effect.mapError(toPluginError("Could not save backup settings.")),
      Effect.flatMap((json) => ctx.storage.set(key, json)),
    );
  const secret = (key: string) =>
    ctx.storage.get(key).pipe(Effect.map(Option.filter((value) => value !== "")));

  const readSettings = readJson(KEYS.settings, BackupSettings).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Schema.decodeEffect(BackupSettings)({}).pipe(
            Effect.mapError(toPluginError("Could not read backup settings.")),
          ),
      }),
    ),
  );
  const readHistory = readJson(KEYS.history, History).pipe(
    Effect.map(Option.getOrElse(() => EMPTY_HISTORY)),
  );
  const updateHistory = (update: (history: History) => History) =>
    readHistory.pipe(
      Effect.flatMap((history) => writeJson(KEYS.history, History, update(history))),
    );

  // --- Status -------------------------------------------------------------------------------

  const isConfigured = Effect.gen(function* () {
    const settings = yield* readSettings;
    if (settings.target === "none" || Option.isNone(yield* secret(KEYS.passphrase))) return false;
    if (settings.target === "s3") return Option.isSome(yield* secret(KEYS.s3Secret));
    return Option.isSome(yield* secret(KEYS.driveToken));
  });

  const scheduledAt = Effect.gen(function* () {
    const [settings, history, configured, now] = yield* Effect.all([
      readSettings,
      readHistory,
      isConfigured,
      Clock.currentTimeMillis,
    ]);
    return configured ? nextRunAt({ ...history, frequency: settings.frequency }, now) : null;
  });

  const status = Effect.gen(function* () {
    const [settings, history, runtime, next] = yield* Effect.all([
      readSettings,
      readHistory,
      Ref.get(state),
      scheduledAt,
    ]);
    const has = (key: string) => secret(key).pipe(Effect.map(Option.isSome));
    return {
      settings,
      stored: {
        passphrase: yield* has(KEYS.passphrase),
        s3SecretAccessKey: yield* has(KEYS.s3Secret),
        driveClientSecret: yield* has(KEYS.driveSecret),
        driveSignedIn: yield* has(KEYS.driveToken),
      },
      pendingSignIn: runtime.pendingSignIn,
      signInError: runtime.signInError,
      activity: runtime.activity,
      lastBackup: history.lastBackup,
      lastResult: history.lastResult,
      nextRunAt: next === null ? null : iso(next),
      pendingRestore: yield* ctx.dataBackup.pendingRestore.pipe(Effect.orElseSucceed(() => null)),
    } satisfies BackupStatus;
  });

  const publishStatus: Effect.Effect<void> = Effect.gen(function* () {
    const current = yield* status;
    const line =
      current.activity !== null
        ? { backup: "Backing up…", verify: "Checking a backup…", restore: "Preparing a restore…" }[
            current.activity.kind
          ]
        : current.pendingRestore !== null
          ? "A restore is waiting for confirmation"
          : current.lastResult !== null && !current.lastResult.ok
            ? current.lastResult.message
            : current.lastBackup !== null
              ? `Last backup ${current.lastBackup.at}`
              : current.settings.target === "none"
                ? "No backup target"
                : "No backups yet";
    yield* ctx.reportStatus(line);
  }).pipe(Effect.ignore);

  const setState = (update: Partial<RuntimeState>) =>
    Ref.update(state, (current) => ({ ...current, ...update })).pipe(Effect.andThen(publishStatus));

  // --- Targets ------------------------------------------------------------------------------

  const driveClient = Effect.gen(function* () {
    const settings = yield* readSettings;
    const clientSecret = yield* secret(KEYS.driveSecret);
    if (settings.drive.clientId.trim() === "" || Option.isNone(clientSecret)) {
      return yield* new PluginError({ message: "Set the Google client ID and secret first." });
    }
    return { clientId: settings.drive.clientId.trim(), clientSecret: clientSecret.value };
  });

  const driveAccessToken = Effect.gen(function* () {
    const stored = yield* readJson(KEYS.driveToken, DriveToken);
    if (Option.isNone(stored)) {
      return yield* new PluginError({ message: "Sign in to Google Drive first." });
    }
    const fresh = yield* refreshIfNeeded(yield* driveClient, stored.value);
    if (Option.isNone(fresh)) {
      yield* ctx.storage.remove(KEYS.driveToken);
      return yield* new PluginError({ message: "The Google sign-in expired. Sign in again." });
    }
    if (fresh.value !== stored.value) yield* writeJson(KEYS.driveToken, DriveToken, fresh.value);
    return fresh.value.accessToken;
  });

  const remote: Effect.Effect<Remote, PluginError> = Effect.gen(function* () {
    const settings = yield* readSettings;
    if (settings.target === "s3") {
      const secretAccessKey = yield* secret(KEYS.s3Secret);
      return yield* makeS3Remote({
        ...settings.s3,
        secretAccessKey: Option.getOrElse(secretAccessKey, () => ""),
      });
    }
    if (settings.target === "google-drive") {
      return yield* makeDriveRemote({
        folderName: settings.drive.folderName,
        accessToken: driveAccessToken.pipe(Effect.provideContext(services)),
      });
    }
    return yield* new PluginError({ message: "Choose where backups go first." });
  }).pipe(Effect.provideContext(services));

  const storedPassphrase = secret(KEYS.passphrase).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () => Effect.fail(new PluginError({ message: "Set a backup passphrase first." })),
      }),
    ),
  );

  // --- Work ---------------------------------------------------------------------------------

  const backupOnce = Effect.fn("backup.run")(function* (target: Remote, passphrase: string) {
    const environmentId = yield* ctx.environment.environmentId;
    const now = yield* Clock.currentTimeMillis;
    const name = backupName(environmentId, now);
    const staged = path.join(workDir, name);
    const sealed = yield* Effect.scoped(
      Effect.gen(function* () {
        const snapshot = yield* ctx.dataBackup.snapshot;
        return yield* fromPromise("Could not encrypt the backup.", () =>
          sealSnapshot({ ...snapshot, destination: staged, passphrase }),
        );
      }),
    );
    yield* target
      .upload(name, { path: staged, ...sealed })
      .pipe(Effect.ensuring(fs.remove(staged).pipe(Effect.ignore)));

    const settings = yield* readSettings;
    const existing = yield* target.list;
    const expired = new Set(
      selectForDeletion(
        existing.map((object) => object.name),
        environmentId,
        settings.keep,
      ),
    );
    // A failed delete only means one extra backup is kept until next time.
    yield* Effect.forEach(
      existing.filter((object) => expired.has(object.name)),
      (object) =>
        target.remove(object).pipe(Effect.catch((error) => Effect.logWarning(error.message))),
      { discard: true },
    );
    const at = iso(now);
    yield* updateHistory((history) => ({
      ...history,
      lastSuccessAt: now,
      lastAttemptAt: now,
      consecutiveFailures: 0,
      lastBackup: { name, bytes: sealed.bytes, at },
      lastResult: {
        kind: "backup",
        ok: true,
        at,
        message: `Backed up ${megabytes(sealed.bytes)}${expired.size > 0 ? `, removed ${expired.size} old` : ""}.`,
      },
    }));
  });

  const findRemote = Effect.fn("backup.find")(function* (target: Remote, name: string) {
    const found = (yield* target.list).find((object) => object.name === name);
    if (found === undefined) {
      return yield* new PluginError({ message: `No backup named ${name}.` });
    }
    return found;
  });

  /** Downloads, decrypts and checks a backup; the unpacked folder is removed with the scope. */
  const openRemote = Effect.fn("backup.open")(function* (
    target: Remote,
    object: RemoteObject,
    passphrase: string,
  ) {
    const file = path.join(workDir, object.name);
    const directory = path.join(workDir, `${object.name}.d`);
    yield* Effect.addFinalizer(() =>
      Effect.all([fs.remove(file), fs.remove(directory, { recursive: true })], {
        discard: true,
      }).pipe(Effect.ignore),
    );
    yield* target.download(object, file);
    const manifest = yield* fromPromise("Could not open the backup.", () =>
      openBackup({ file, directory, passphrase }),
    );
    return { directory, manifest };
  });

  const recordResult = (kind: ActivityKind, ok: boolean, message: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        updateHistory((history) => ({
          ...history,
          ...(kind === "backup" && !ok
            ? { lastAttemptAt: now, consecutiveFailures: history.consecutiveFailures + 1 }
            : {}),
          lastResult: { kind, ok, at: iso(now), message },
        })),
      ),
    );

  /**
   * Runs `work` in the background, one job at a time, reporting through `activity` and
   * `lastResult`. Actions return at once, since a backup can outlast any request.
   */
  const startJob = Effect.fn("backup.startJob")(function* (
    kind: ActivityKind,
    name: string | null,
    work: Effect.Effect<string | void, PluginError>,
  ) {
    const busy = (yield* Ref.get(state)).activity;
    if (busy !== null) {
      return yield* new PluginError({ message: "Another backup task is still running." });
    }
    const startedAt = iso(yield* Clock.currentTimeMillis);
    yield* setState({ activity: { kind, name, startedAt } });
    yield* workLock
      .withPermits(1)(work)
      .pipe(
        Effect.flatMap((message) =>
          typeof message === "string" ? recordResult(kind, true, message) : Effect.void,
        ),
        Effect.catch((error) => recordResult(kind, false, error.message)),
        Effect.ensuring(setState({ activity: null })),
        Effect.ensuring(Queue.offer(wake, undefined)),
        Effect.forkIn(pluginScope),
      );
  });

  // --- Actions ------------------------------------------------------------------------------

  const backupNow = Effect.gen(function* () {
    const target = yield* remote;
    const passphrase = yield* storedPassphrase;
    yield* startJob("backup", null, backupOnce(target, passphrase));
    return yield* status;
  });

  const verify = Effect.fn("backup.verify")(function* (input: {
    readonly name: string;
    readonly passphrase?: string;
  }) {
    const target = yield* remote;
    const passphrase = input.passphrase ?? (yield* storedPassphrase);
    const work = Effect.scoped(
      Effect.gen(function* () {
        const object = yield* findRemote(target, input.name);
        const { manifest } = yield* openRemote(target, object, passphrase);
        return `${input.name} is intact: ${manifest.files.length} files, made ${manifest.createdAt}.`;
      }),
    );
    yield* startJob("verify", input.name, work);
    return yield* status;
  });

  const restore = Effect.fn("backup.restore")(function* (input: {
    readonly name: string;
    readonly passphrase?: string;
  }) {
    const target = yield* remote;
    const passphrase = input.passphrase ?? (yield* storedPassphrase);
    const work = Effect.scoped(
      Effect.gen(function* () {
        const object = yield* findRemote(target, input.name);
        const { directory } = yield* openRemote(target, object, passphrase);
        // The host takes the folder over; nothing live changes until a person confirms there.
        yield* ctx.dataBackup.stageRestore(directory);
        return "Ready to restore. p0code asks you to confirm before replacing anything.";
      }),
    );
    yield* startJob("restore", input.name, work);
    return yield* status;
  });

  const list = Effect.gen(function* () {
    const target = yield* remote;
    const environmentId = yield* ctx.environment.environmentId;
    const own = nameId(environmentId);
    const backups = (yield* target.list).flatMap((object): Array<RemoteBackup> => {
      const parsed = parseBackupName(object.name);
      if (parsed === null) return [];
      return [
        {
          name: object.name,
          bytes: object.bytes,
          createdAt: iso(parsed.createdAt),
          environmentId: parsed.environmentId,
          mine: parsed.environmentId === own,
        },
      ];
    });
    return { backups: backups.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) };
  });

  const setSettings = Effect.fn("backup.setSettings")(function* (patch: BackupSettingsPatch) {
    const current = yield* readSettings;
    const { secretAccessKey, ...s3 } = patch.s3 ?? {};
    const { clientSecret, ...drive } = patch.drive ?? {};
    const next: BackupSettings = {
      target: patch.target ?? current.target,
      frequency: patch.frequency ?? current.frequency,
      keep: patch.keep ?? current.keep,
      s3: { ...current.s3, ...s3 },
      drive: { ...current.drive, ...drive },
    };
    const putSecret = (key: string, value: string | undefined) =>
      value === undefined
        ? Effect.void
        : value === ""
          ? ctx.storage.remove(key)
          : ctx.storage.set(key, value);
    yield* putSecret(KEYS.s3Secret, secretAccessKey);
    yield* putSecret(KEYS.driveSecret, clientSecret);
    yield* putSecret(KEYS.passphrase, patch.passphrase);
    // A token belongs to the client that issued it.
    if (next.drive.clientId !== current.drive.clientId) yield* ctx.storage.remove(KEYS.driveToken);
    yield* writeJson(KEYS.settings, BackupSettings, next);
    yield* Queue.offer(wake, undefined);
    yield* publishStatus;
    return yield* status;
  });

  const cancelSignIn = Effect.gen(function* () {
    const fiber = signInFiber;
    signInFiber = null;
    if (fiber !== null) yield* Fiber.interrupt(fiber);
    yield* setState({ pendingSignIn: null });
  });

  const driveSignIn = Effect.gen(function* () {
    if ((yield* Ref.get(state)).pendingSignIn !== null) return yield* status;
    const client = yield* driveClient;
    const authorization: DeviceAuthorization = yield* startDeviceAuthorization(client).pipe(
      Effect.provideContext(services),
    );
    yield* setState({
      pendingSignIn: {
        verificationUrl: authorization.verificationUrl,
        userCode: authorization.userCode,
      },
      signInError: null,
    });
    signInFiber = yield* pollDeviceToken(client, authorization).pipe(
      Effect.flatMap((token) => writeJson(KEYS.driveToken, DriveToken, token)),
      Effect.andThen(Queue.offer(wake, undefined)),
      Effect.catch((error) => setState({ signInError: error.message })),
      Effect.ensuring(
        Effect.suspend(() => {
          signInFiber = null;
          return setState({ pendingSignIn: null });
        }),
      ),
      Effect.provideContext(services),
      Effect.asVoid,
      Effect.forkIn(pluginScope),
    );
    return yield* status;
  });

  const driveSignOut = Effect.gen(function* () {
    yield* cancelSignIn;
    const token = yield* readJson(KEYS.driveToken, DriveToken);
    if (Option.isSome(token)) {
      yield* revokeToken(token.value).pipe(Effect.provideContext(services));
    }
    yield* ctx.storage.remove(KEYS.driveToken);
    yield* setState({ signInError: null });
    return yield* status;
  });

  const cancelRestore = Effect.gen(function* () {
    yield* ctx.dataBackup.cancelRestore;
    yield* publishStatus;
    return yield* status;
  });

  // --- Schedule -----------------------------------------------------------------------------

  const scheduler = Effect.gen(function* () {
    const next = yield* scheduledAt;
    if (next === null) return yield* Queue.take(wake);
    const wait = Math.max(0, next - (yield* Clock.currentTimeMillis));
    const delay = Duration.min(Duration.millis(wait), MAX_SLEEP);
    const woken = yield* Effect.race(
      Effect.sleep(delay).pipe(Effect.as(false)),
      Queue.take(wake).pipe(Effect.as(true)),
    );
    if (woken || (yield* Clock.currentTimeMillis) < next) return;
    if ((yield* Ref.get(state)).activity !== null) return yield* Queue.take(wake);
    yield* Effect.gen(function* () {
      const target = yield* remote;
      const passphrase = yield* storedPassphrase;
      yield* startJob("backup", null, backupOnce(target, passphrase));
    }).pipe(Effect.catch((error) => recordResult("backup", false, error.message)));
    yield* Queue.take(wake);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Backup scheduler step failed", { cause }).pipe(
        Effect.andThen(Effect.sleep(MAX_SLEEP)),
      ),
    ),
    Effect.forever,
  );

  yield* scheduler.pipe(Effect.forkIn(pluginScope));
  yield* publishStatus;

  return {
    status,
    setSettings,
    driveSignIn,
    driveSignOut,
    backupNow,
    list,
    verify,
    restore,
    cancelRestore,
  };
});
