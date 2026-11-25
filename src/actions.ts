import { PendingRestore } from "@t3tools/plugin-api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const BACKUP_PLUGIN_ID = "backup";

export const Frequency = Schema.Literals(["off", "hourly", "daily", "weekly"]);
export type Frequency = typeof Frequency.Type;

export const TargetKind = Schema.Literals(["none", "google-drive", "s3"]);
export type TargetKind = typeof TargetKind.Type;

const withDefault = <S extends Schema.Top>(schema: S, value: S["Encoded"]) =>
  schema.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

export const S3Settings = Schema.Struct({
  /** e.g. https://s3.us-east-1.amazonaws.com, https://<account>.r2.cloudflarestorage.com */
  endpoint: withDefault(Schema.String, ""),
  region: withDefault(Schema.String, "us-east-1"),
  bucket: withDefault(Schema.String, ""),
  /** Prepended to every object name, e.g. `p0code/`. */
  prefix: withDefault(Schema.String, ""),
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. */
  forcePathStyle: withDefault(Schema.Boolean, false),
  accessKeyId: withDefault(Schema.String, ""),
});
export type S3Settings = typeof S3Settings.Type;

export const DriveSettings = Schema.Struct({
  /** An OAuth client of type "TVs and Limited Input devices" in the person's own Google project. */
  clientId: withDefault(Schema.String, ""),
  folderName: withDefault(Schema.String, "p0code backups"),
});
export type DriveSettings = typeof DriveSettings.Type;

const Keep = Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1000 }));

export const BackupSettings = Schema.Struct({
  target: withDefault(TargetKind, "none"),
  frequency: withDefault(Frequency, "daily"),
  keep: withDefault(Keep, 14),
  s3: withDefault(S3Settings, {}),
  drive: withDefault(DriveSettings, {}),
});
export type BackupSettings = typeof BackupSettings.Type;

/** Secrets are write-only: set here, reported back only as present or not. */
export const BackupSettingsPatch = Schema.Struct({
  target: Schema.optionalKey(TargetKind),
  frequency: Schema.optionalKey(Frequency),
  keep: Schema.optionalKey(Keep),
  s3: Schema.optionalKey(
    Schema.Struct({
      endpoint: Schema.optionalKey(Schema.String),
      region: Schema.optionalKey(Schema.String),
      bucket: Schema.optionalKey(Schema.String),
      prefix: Schema.optionalKey(Schema.String),
      forcePathStyle: Schema.optionalKey(Schema.Boolean),
      accessKeyId: Schema.optionalKey(Schema.String),
      secretAccessKey: Schema.optionalKey(Schema.String),
    }),
  ),
  drive: Schema.optionalKey(
    Schema.Struct({
      clientId: Schema.optionalKey(Schema.String),
      clientSecret: Schema.optionalKey(Schema.String),
      folderName: Schema.optionalKey(Schema.String),
    }),
  ),
  passphrase: Schema.optionalKey(Schema.String.check(Schema.isMinLength(12))),
});
export type BackupSettingsPatch = typeof BackupSettingsPatch.Type;

export const ActivityKind = Schema.Literals(["backup", "verify", "restore"]);
export type ActivityKind = typeof ActivityKind.Type;

export const BackupStatus = Schema.Struct({
  settings: BackupSettings,
  /** Which secrets are stored; never their values. */
  stored: Schema.Struct({
    passphrase: Schema.Boolean,
    s3SecretAccessKey: Schema.Boolean,
    driveClientSecret: Schema.Boolean,
    driveSignedIn: Schema.Boolean,
  }),
  /** A Google device code waiting to be approved in a browser. */
  pendingSignIn: Schema.NullOr(
    Schema.Struct({ verificationUrl: Schema.String, userCode: Schema.String }),
  ),
  signInError: Schema.NullOr(Schema.String),
  activity: Schema.NullOr(
    Schema.Struct({
      kind: ActivityKind,
      name: Schema.NullOr(Schema.String),
      startedAt: Schema.String,
    }),
  ),
  lastBackup: Schema.NullOr(
    Schema.Struct({ name: Schema.String, bytes: Schema.Number, at: Schema.String }),
  ),
  lastResult: Schema.NullOr(
    Schema.Struct({
      kind: ActivityKind,
      ok: Schema.Boolean,
      at: Schema.String,
      message: Schema.String,
    }),
  ),
  nextRunAt: Schema.NullOr(Schema.String),
  /** A restore staged with the host, waiting for confirmation in the host's own flow. */
  pendingRestore: Schema.NullOr(PendingRestore),
});
export type BackupStatus = typeof BackupStatus.Type;

export const RemoteBackup = Schema.Struct({
  name: Schema.String,
  bytes: Schema.Number,
  createdAt: Schema.String,
  environmentId: Schema.String,
  /** Made by this environment, so subject to its retention. */
  mine: Schema.Boolean,
});
export type RemoteBackup = typeof RemoteBackup.Type;

const NoInput = Schema.Struct({});
const BackupRef = Schema.Struct({
  name: Schema.String,
  /** For a backup made with an older passphrase; the stored one is used otherwise. */
  passphrase: Schema.optionalKey(Schema.String),
});

/** The actions the settings panel calls through `plugins.invoke`. Long work runs in the
 * background: these return at once and `status.activity` / `lastResult` report progress. */
export const backupActions = {
  status: { input: NoInput, output: BackupStatus },
  setSettings: { input: BackupSettingsPatch, output: BackupStatus },
  driveSignIn: { input: NoInput, output: BackupStatus },
  driveSignOut: { input: NoInput, output: BackupStatus },
  backupNow: { input: NoInput, output: BackupStatus },
  list: { input: NoInput, output: Schema.Struct({ backups: Schema.Array(RemoteBackup) }) },
  verify: { input: BackupRef, output: BackupStatus },
  restore: { input: BackupRef, output: BackupStatus },
  cancelRestore: { input: NoInput, output: BackupStatus },
} as const;
export type BackupAction = keyof typeof backupActions;
