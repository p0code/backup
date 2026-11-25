# Host API proposal: `data:backup`

The plugin API gives a plugin its own `dataDir`, its own `storage`, and nothing of the user's
data. A backup plugin needs two things only the host can do safely while the server runs:

1. take a **consistent copy** of the user's data, and
2. **put a copy back**, which must never happen behind the user's back or under a live server.

This document proposes the smallest host surface for both. The plugin in this repository is
written against exactly this interface (see `standalone/stubs/plugin-api.ts`, which is upstream's
`@t3tools/plugin-api` plus the additions below), so it builds in the workspace as soon as the
host lands it.

## Capability

Add `"data:backup"` to `PluginCapability` in `packages/contracts/src/plugins.ts`. Like
`auth:issue-device-credentials`, it is brokered: `contextFor` in
`apps/server/src/plugins/bindings.ts` hands out the real implementation only when the manifest
declares it, and a refusing stub otherwise. The enable dialog should say what it means in
plain words: _"Can read a copy of all your chats, attachments and settings, and can propose
replacing them with a backup."_

## Types (contracts, re-exported by plugin-api)

```ts
/** `manifest.json` at the root of a data snapshot. */
export const DataSnapshotManifest = Schema.Struct({
  format: Schema.Literal(1),
  createdAt: Schema.String, // ISO 8601
  environmentId: Schema.String, // the environment the copy came from
  appVersion: Schema.String,
  /** Highest migration the copied database records; older builds cannot open it. */
  migrationHead: Schema.Number,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, bytes: Schema.Number, sha256: Schema.String }),
  ),
});

/** A verified snapshot waiting for a person to confirm it in the host's own restore flow. */
export const PendingRestore = Schema.Struct({
  id: Schema.String,
  stagedAt: Schema.String,
  snapshotCreatedAt: Schema.String,
  sourceEnvironmentId: Schema.String,
  files: Schema.Number,
  bytes: Schema.Number,
});
```

## `PluginContext.dataBackup`

```ts
/** Requires the `data:backup` capability. */
readonly dataBackup: {
  readonly snapshot: Effect.Effect<
    { readonly directory: string; readonly manifest: DataSnapshotManifest },
    PluginError,
    Scope.Scope
  >;
  readonly stageRestore: (directory: string) => Effect.Effect<PendingRestore, PluginError>;
  readonly pendingRestore: Effect.Effect<PendingRestore | null, PluginError>;
  readonly cancelRestore: Effect.Effect<void, PluginError>;
};
```

### `snapshot`

Writes a consistent copy into a new directory under the plugin's `dataDir` and returns it. The
directory belongs to the caller's scope: the host removes it when the scope closes, so a crash
or an interrupted backup leaves nothing behind (the host also clears stale snapshot folders at
plugin start).

Layout, relative to the directory (paths in the manifest always use `/`):

| Path               | Source                         | How it is copied                                                       |
| ------------------ | ------------------------------ | ---------------------------------------------------------------------- |
| `statev2.sqlite`   | `config.dbPath`                | `VACUUM INTO` from a separate read-only connection (see below)         |
| `attachments/**`   | `config.attachmentsDir`        | per file, regular files only; clone (`COPYFILE_FICLONE`) when possible |
| `settings.json`    | `config.settingsPath`          | whole file, as the server last wrote it                                |
| `keybindings.json` | `config.keybindingsConfigPath` | whole file                                                             |
| `manifest.json`    | written last                   | size and SHA-256 of every file above                                   |

**The database is never copied as a file.** The server runs SQLite in WAL mode; copying
`statev2.sqlite` while it runs can miss committed pages that still live in `-wal`, or catch a
checkpoint half-way. The host does what `p0 migrate` (`packages/shared/src/migrateFromT3.ts`,
`snapshotDatabase`) and the V1 import (`initializeV2Database.ts`, `snapshotWorkerSource`)
already do: open a second, read-only `node:sqlite` connection and run `VACUUM INTO ?`. That
reads one transaction-consistent view, including committed WAL frames, and writes a compact,
self-contained file with no `-wal`/`-shm`. It runs in a worker thread so a large database does
not block the event loop, and it never blocks the server's writers (WAL readers do not block
writers). The SQLite online backup API (`node:sqlite`'s `backup()`) is an acceptable
alternative; `VACUUM INTO` is preferred because the copy is compacted and the code path already
exists. After the copy the host runs `PRAGMA quick_check` on it and reads `migrationHead` from
its `effect_sql_migrations` (as `recordedMigrations` in `databaseMigrationHead.ts` does).

Before copying, the host checks free space (the copy needs about the database size plus the
attachments) and fails with a clear `PluginError` rather than filling the disk. One snapshot
runs at a time per server.

**Never included:** `secrets/` and every OS keychain entry (`credentialKeychain.ts`),
`environment-id`, `server-signing-key`, provider homes, logs, caches, runtime state
(`server-runtime.json`, `server-owner.sqlite*`), and `plugins/` (which also keeps a backup
plugin from backing up its own scratch files). Restored machines sign in to providers and pair
devices again; that is the price of never letting credentials leave the keychain.

### `stageRestore(directory)`

Hands a snapshot directory (same layout, typically unpacked from a backup) to the host. The host:

1. refuses a directory outside the calling plugin's `dataDir`;
2. **moves** it (rename, same file system) to `<stateDir>/restore-pending/`, so the plugin can
   no longer change it; a previous pending restore is replaced;
3. verifies it independently of the plugin: manifest decodes, every listed file exists with its
   size and SHA-256, nothing unlisted, no symlinks, safe paths, `statev2.sqlite` present and
   passes `PRAGMA integrity_check`;
4. checks compatibility: `migrationHead <= BUILD_MIGRATION_HEAD` and
   `incompatibleSourceMigrations` (from `migrationManifest.ts`) is empty, otherwise refuses with
   _"This backup was made by a newer p0code."_ An older backup is fine; migrations bring it
   forward on start;
5. returns `PendingRestore`.

**Nothing live changes.** Staging only makes a restore _available_.

### The host's restore flow (not callable by plugins)

- The host shows the pending restore in its own UI (a banner in Settings, and in the Plugins
  page), with what it came from (`snapshotCreatedAt`, `sourceEnvironmentId`) and what it
  replaces. Applying it is a host RPC that needs `relay:configure`, the administrative scope that
  already guards plugins. There is deliberately no `applyRestore` on `PluginContext`.
- Confirming marks the restore as approved and restarts the server (the desktop app relaunches
  its backend). At the next start, while holding the server-owner lock and **before** the
  database is opened, the host moves the current `statev2.sqlite` (with `-wal`/`-shm`),
  `attachments/`, `settings.json` and `keybindings.json` into
  `<stateDir>/restore-replaced-<timestamp>/`, then moves the staged files into place. Nothing is
  deleted: the replaced data stays until the user removes it, as `p0 migrate --force` keeps its
  replaced destination.
- If the snapshot came from a different home path, `settings.json` gets the same absolute path
  rewrite `p0 migrate` applies (`makePathRewriter`).
- If any step fails, the host moves the replaced files back and reports the error; the pending
  restore stays for another try or cancellation.

### `pendingRestore` / `cancelRestore`

Read or drop the pending restore (dropping deletes `restore-pending/`). Both are safe to call at
any time; the plugin uses them to show and undo its own staging.

## Bindings sketch

```ts
// apps/server/src/plugins/bindings.ts, inside contextFor
dataBackup: declared("data:backup")
  ? {
      snapshot: dataSnapshots.create(dataDir).pipe(
        Effect.mapError(hostError("Could not take a snapshot of your data.")),
      ),
      stageRestore: (directory) =>
        restores.stage({ directory, within: dataDir }).pipe(
          Effect.mapError(hostError("Could not stage the restore.")),
        ),
      pendingRestore: restores.pending.pipe(Effect.mapError(hostError("Could not read the restore."))),
      cancelRestore: restores.cancel.pipe(Effect.mapError(hostError("Could not cancel the restore."))),
    }
  : { snapshot: refused, stageRestore: () => refused, pendingRestore: refused, cancelRestore: refused },
```

`dataSnapshots` and `restores` would be two small server services next to
`persistence/DatabaseMaintenance.ts`, sharing its free-space check and `sqliteTempDirectory`.

## Mounting this plugin

Once the host has the above:

1. `git submodule add https://github.com/p0code/backup plugins/backup`
2. add `backupPlugin` from `@t3tools/plugin-backup` to `apps/server/src/plugins/registry.ts`
3. move `web/BackupPanel.tsx` to `apps/web/src/components/settings/BackupPanel.tsx` and register
   `[BACKUP_PLUGIN_ID]: { Disclosure: BackupDisclosure, Panel: BackupPanel }` in
   `PluginsSettings.tsx`
4. give knip a `plugins/backup` workspace entry with `"ignore": ["standalone/**", "web/**"]`
   (the standalone test harness and the panel draft are not part of the package)
