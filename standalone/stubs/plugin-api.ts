// @effect-diagnostics deterministicKeys:off -- Keeps the real package's service key.
/**
 * Test and typecheck stand-in for `@t3tools/plugin-api` outside a p0code checkout.
 *
 * It is upstream's packages/plugin-api/src/index.ts with the `@t3tools/contracts` types inlined,
 * plus the `data:backup` capability and `PluginContext.dataBackup` proposed in docs/HOST_API.md.
 * Inside the workspace the real package is used instead.
 */
import * as Context from "effect/Context";
import type * as Digest from "effect/crypto/Digest";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import type * as Signature from "effect/crypto/Signature";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as HttpClient from "effect/http/HttpClient";
import type * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

// --- @t3tools/contracts, reduced to what this plugin touches ---
type EnvironmentId = string;
type ThreadId = string;
type ExecutionEnvironmentDescriptor = Readonly<Record<string, unknown>>;
type AgentAwarenessState = Readonly<Record<string, unknown>>;
type UsageDailyTotal = Readonly<Record<string, unknown>>;
declare namespace PtyAdapter {
  interface PtyAdapter {
    readonly _: unique symbol;
  }
}
export type PluginCapability =
  | "network:outbound"
  | "process:spawn"
  | "http:routes"
  | "auth:issue-device-credentials"
  | "orchestration:read-activity"
  | "agent:instructions"
  // Proposed in docs/HOST_API.md.
  | "data:backup";
export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly unofficial: boolean;
  readonly externalServices: ReadonlyArray<string>;
  readonly capabilities: ReadonlyArray<PluginCapability>;
  readonly httpRoutes: ReadonlyArray<string>;
}

// --- Proposed in docs/HOST_API.md (would live in contracts' plugins.ts) ---

/** `manifest.json` at the root of a data snapshot. */
export const DataSnapshotManifest = Schema.Struct({
  format: Schema.Literal(1),
  createdAt: Schema.String,
  environmentId: Schema.String,
  appVersion: Schema.String,
  /** Highest migration the copied database records; older builds cannot open it. */
  migrationHead: Schema.Number,
  files: Schema.Array(
    Schema.Struct({ path: Schema.String, bytes: Schema.Number, sha256: Schema.String }),
  ),
});
export type DataSnapshotManifest = typeof DataSnapshotManifest.Type;

/** A verified snapshot waiting for a person to confirm it in the host's own restore flow. */
export const PendingRestore = Schema.Struct({
  id: Schema.String,
  stagedAt: Schema.String,
  snapshotCreatedAt: Schema.String,
  sourceEnvironmentId: Schema.String,
  files: Schema.Number,
  bytes: Schema.Number,
});
export type PendingRestore = typeof PendingRestore.Type;

/** A failure a plugin reports to its caller; the message is shown to people. */
export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export type ActivityState = AgentAwarenessState;

/** Everything the host lends a running plugin. It lives as long as the plugin stays enabled. */
export class PluginContext extends Context.Service<
  PluginContext,
  {
    readonly pluginId: string;
    /** A directory only this plugin writes, kept across restarts. */
    readonly dataDir: string;
    /** Values kept in the server's secret store, namespaced to the plugin. */
    readonly storage: {
      readonly get: (key: string) => Effect.Effect<Option.Option<string>, PluginError>;
      readonly set: (key: string, value: string) => Effect.Effect<void, PluginError>;
      readonly remove: (key: string) => Effect.Effect<void, PluginError>;
    };
    /** The one-line status shown beside the plugin; null clears it. */
    readonly reportStatus: (message: string | null) => Effect.Effect<void>;
    readonly environment: {
      readonly environmentId: Effect.Effect<EnvironmentId>;
      readonly descriptor: Effect.Effect<ExecutionEnvironmentDescriptor>;
      /** This server's own loopback HTTP origin, for helpers that must reach it. */
      readonly localOrigin: Effect.Effect<string, PluginError>;
    };
    /** Requires the `auth:issue-device-credentials` capability. */
    readonly deviceAccess: {
      /**
       * A short-lived one-time pairing credential bound to a device's DPoP key. Sessions it
       * creates belong to this plugin and end when the plugin is disabled.
       */
      readonly issueCredential: (input: {
        readonly proofKeyThumbprint: string;
        readonly label: string;
      }) => Effect.Effect<
        { readonly credential: string; readonly expiresAt: DateTime.Utc },
        PluginError
      >;
      readonly revokeAll: Effect.Effect<void, PluginError>;
    };
    /** Requires the `orchestration:read-activity` capability. */
    readonly agentActivity: {
      /** Threads whose activity may have changed. */
      readonly changes: Stream.Stream<ThreadId>;
      readonly read: (threadId: ThreadId) => Effect.Effect<ActivityState | null, PluginError>;
      /** Listed threads that are working or waiting now. */
      readonly activeThreadIds: Effect.Effect<ReadonlyArray<ThreadId>, PluginError>;
    };
    /** Proposed in docs/HOST_API.md. Requires the `data:backup` capability. */
    readonly dataBackup: {
      /**
       * A consistent copy of the user's data in a new directory under `dataDir`, with
       * `manifest.json` at its root. The host removes the directory when the scope closes.
       */
      readonly snapshot: Effect.Effect<
        { readonly directory: string; readonly manifest: DataSnapshotManifest },
        PluginError,
        Scope.Scope
      >;
      /**
       * Moves a snapshot directory into the host's restore flow. The host verifies it and
       * keeps it pending; nothing live changes until a person confirms in the host's UI.
       */
      readonly stageRestore: (directory: string) => Effect.Effect<PendingRestore, PluginError>;
      readonly pendingRestore: Effect.Effect<PendingRestore | null, PluginError>;
      readonly cancelRestore: Effect.Effect<void, PluginError>;
    };
    /** Requires the `usage:read` capability. */
    readonly usage: {
      /** Daily totals per provider and model; days with no usage are absent. */
      readonly dailyTotals: (input: {
        readonly sinceDay: string;
        readonly untilDay: string;
        readonly timeZone: string;
      }) => Effect.Effect<ReadonlyArray<UsageDailyTotal>, PluginError>;
    };
  }
>()("@t3tools/plugin-api/PluginContext") {}

export type PluginServices =
  | PluginContext
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | PtyAdapter.PtyAdapter
  | Digest.Digest
  | SecureRandom.SecureRandom
  | Signature.Signature;

export interface PluginActionSchema {
  readonly input: Schema.Codec<unknown, unknown>;
  readonly output: Schema.Codec<unknown, unknown>;
}
export type PluginActionSchemas = Readonly<Record<string, PluginActionSchema>>;

/** A JSON request to a declared route; the response is JSON with no caching. */
export type PluginRouteHandler = (
  body: unknown,
) => Effect.Effect<{ readonly status: number; readonly body: unknown }>;

export interface PluginInstance<Actions extends PluginActionSchemas> {
  readonly actions: {
    readonly [K in keyof Actions]: (
      input: Actions[K]["input"]["Type"],
    ) => Effect.Effect<Actions[K]["output"]["Type"], PluginError>;
  };
  readonly routes?: Readonly<Record<string, PluginRouteHandler>>;
  /** Optional text appended to every agent turn; requires `agent:instructions`. */
  readonly agentInstructions?: Effect.Effect<string | null>;
}

/** What the host runs. Built by `definePlugin`, which owns decoding at the wire. */
export interface Plugin {
  readonly manifest: PluginManifest;
  /** Runs in the plugin's scope; closing it is how the host stops the plugin. */
  readonly start: Effect.Effect<StartedPlugin, PluginError, PluginServices | Scope.Scope>;
}

export interface StartedPlugin {
  readonly invoke: (action: string, input: unknown) => Effect.Effect<unknown, PluginError>;
  readonly routes: ReadonlyMap<string, PluginRouteHandler>;
  readonly agentInstructions?: Effect.Effect<string | null>;
}

export function definePlugin<Actions extends PluginActionSchemas>(definition: {
  readonly manifest: PluginManifest;
  readonly actions: Actions;
  readonly start: Effect.Effect<PluginInstance<Actions>, PluginError, PluginServices | Scope.Scope>;
}): Plugin {
  // Compiled once per plugin, not per call.
  const codecs = new Map(
    Object.entries(definition.actions).map(([action, schema]) => [
      action,
      {
        decode: Schema.decodeUnknownEffect(schema.input),
        encode: Schema.encodeEffect(schema.output),
      },
    ]),
  );
  return {
    manifest: definition.manifest,
    start: definition.start.pipe(
      Effect.flatMap((instance) => {
        const routes = new Map(Object.entries(instance.routes ?? {}));
        for (const path of routes.keys()) {
          if (!definition.manifest.httpRoutes.includes(path)) {
            return Effect.fail(new PluginError({ message: `Route ${path} is not declared.` }));
          }
        }
        if (
          instance.agentInstructions !== undefined &&
          !definition.manifest.capabilities.includes("agent:instructions")
        ) {
          return Effect.fail(
            new PluginError({ message: "Capability agent:instructions is not declared." }),
          );
        }
        const invoke = (action: string, input: unknown) => {
          const codec = codecs.get(action);
          const handler = Object.hasOwn(instance.actions, action)
            ? instance.actions[action]
            : undefined;
          if (codec === undefined || handler === undefined) {
            return Effect.fail(new PluginError({ message: `Unknown action ${action}.` }));
          }
          return codec.decode(input).pipe(
            Effect.mapError(
              (cause) => new PluginError({ message: "Invalid action input.", cause }),
            ),
            Effect.flatMap(handler),
            Effect.flatMap((output) =>
              codec
                .encode(output)
                .pipe(
                  Effect.mapError(
                    (cause) => new PluginError({ message: "Invalid action output.", cause }),
                  ),
                ),
            ),
          );
        };
        return Effect.succeed({
          invoke,
          routes,
          ...(instance.agentInstructions === undefined
            ? {}
            : { agentInstructions: instance.agentInstructions }),
        } satisfies StartedPlugin);
      }),
    ),
  };
}
