import type { PluginError } from "@t3tools/plugin-api";
import type * as Effect from "effect/Effect";

/** A backup file stored remotely; `id` is what the store addresses it by. */
export interface RemoteObject {
  readonly id: string;
  readonly name: string;
  readonly bytes: number;
}

/** An encrypted backup written locally, ready to upload. */
export interface StagedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Where backups go. Every target only ever sees ciphertext. */
export interface Remote {
  /** Backup files this plugin named (see backups.ts), from every environment. */
  readonly list: Effect.Effect<ReadonlyArray<RemoteObject>, PluginError>;
  readonly upload: (name: string, file: StagedFile) => Effect.Effect<void, PluginError>;
  readonly download: (
    object: RemoteObject,
    destination: string,
  ) => Effect.Effect<void, PluginError>;
  readonly remove: (object: RemoteObject) => Effect.Effect<void, PluginError>;
}
