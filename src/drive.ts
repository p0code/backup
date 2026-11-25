import { PluginError } from "@t3tools/plugin-api";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { BACKUP_SUFFIX, parseBackupName } from "./backups.ts";
import type { Remote, RemoteObject, StagedFile } from "./remote.ts";

/** Only files this OAuth client created; the rest of the person's Drive stays out of reach. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DEVICE_CODE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const REQUEST_TIMEOUT = Duration.seconds(20);
const REFRESH_EARLY_MS = 5 * 60_000;

export interface DriveClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export const DriveToken = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAtEpochMs: Schema.Number,
});
export type DriveToken = typeof DriveToken.Type;

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Number,
});
const ErrorResponse = Schema.Struct({ error: Schema.String });
const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_url: Schema.String,
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
});
const FileList = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, size: Schema.optional(Schema.String) }),
  ),
  nextPageToken: Schema.optional(Schema.String),
});
const CreatedFile = Schema.Struct({ id: Schema.String, size: Schema.optional(Schema.String) });

const isPluginError = Schema.is(PluginError);
const wrap = (message: string) => (cause: unknown) =>
  isPluginError(cause) ? cause : new PluginError({ message, cause });

/** A string literal for a Drive `q` query. */
export const driveQueryString = (value: string) =>
  `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

const postForm = (url: string, params: Record<string, string>) =>
  HttpClient.HttpClient.pipe(
    Effect.flatMap((client) =>
      client.execute(HttpClientRequest.post(url).pipe(HttpClientRequest.bodyUrlParams(params))),
    ),
    Effect.timeout(REQUEST_TIMEOUT),
  );

const toToken = (body: typeof TokenResponse.Type, previous?: DriveToken) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now): DriveToken => ({
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? previous?.refreshToken ?? "",
      expiresAtEpochMs: now + body.expires_in * 1_000,
    })),
  );

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly expiresIn: Duration.Duration;
  readonly interval: Duration.Duration;
}

/** Google's device flow: approve on any device, so it works for a server on another machine. */
export const startDeviceAuthorization = Effect.fn("backup.drive.startDevice")(
  function* (client: DriveClient) {
    const response = yield* postForm(DEVICE_CODE_URL, {
      client_id: client.clientId,
      scope: DRIVE_SCOPE,
    });
    if (response.status >= 400) {
      const failure = yield* HttpClientResponse.schemaBodyJson(ErrorResponse)(response).pipe(
        Effect.option,
      );
      return yield* new PluginError({
        message: Option.match(failure, {
          onNone: () => `Google refused the sign-in (${response.status}).`,
          onSome: ({ error }) =>
            error === "invalid_client"
              ? 'Google does not know this client ID. Use a client of type "TVs and Limited Input devices".'
              : `Google refused the sign-in (${error}).`,
        }),
      });
    }
    const body = yield* HttpClientResponse.schemaBodyJson(DeviceCodeResponse)(response);
    return {
      deviceCode: body.device_code,
      userCode: body.user_code,
      verificationUrl: body.verification_url,
      expiresIn: Duration.seconds(body.expires_in),
      interval: Duration.seconds(body.interval ?? 5),
    } satisfies DeviceAuthorization;
  },
  Effect.mapError(wrap("Could not reach Google sign-in.")),
);

export const pollDeviceToken = Effect.fn("backup.drive.pollDevice")(
  function* (client: DriveClient, authorization: DeviceAuthorization) {
    let interval = authorization.interval;
    while (true) {
      yield* Effect.sleep(interval);
      const response = yield* postForm(TOKEN_URL, {
        client_id: client.clientId,
        client_secret: client.clientSecret,
        device_code: authorization.deviceCode,
        grant_type: DEVICE_CODE_GRANT,
      }).pipe(Effect.option);
      if (Option.isNone(response) || response.value.status >= 500) {
        interval = Duration.sum(interval, Duration.seconds(5));
        continue;
      }
      if (response.value.status < 300) {
        const body = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response.value);
        if (body.refresh_token === undefined) {
          return yield* new PluginError({ message: "Google did not grant offline access." });
        }
        return yield* toToken(body);
      }
      const failure = yield* HttpClientResponse.schemaBodyJson(ErrorResponse)(response.value);
      if (failure.error === "authorization_pending") continue;
      if (failure.error === "slow_down") {
        interval = Duration.sum(interval, Duration.seconds(5));
        continue;
      }
      return yield* new PluginError({
        message:
          failure.error === "access_denied"
            ? "Sign-in was denied."
            : failure.error === "expired_token"
              ? "The sign-in code expired."
              : failure.error === "invalid_client"
                ? "Google rejected the client secret."
                : `Sign-in failed (${failure.error}).`,
      });
    }
  },
  (effect, _client, authorization) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: authorization.expiresIn,
        orElse: () => Effect.fail(new PluginError({ message: "The sign-in code expired." })),
      }),
    ),
  Effect.mapError(wrap("Could not finish Google sign-in.")),
);

/** A fresh access token, refreshing near expiry. `None` means the person must sign in again. */
export const refreshIfNeeded = Effect.fn("backup.drive.refresh")(function* (
  client: DriveClient,
  token: DriveToken,
) {
  const now = yield* Clock.currentTimeMillis;
  if (token.expiresAtEpochMs - REFRESH_EARLY_MS > now) return Option.some(token);
  const response = yield* postForm(TOKEN_URL, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: token.refreshToken,
    grant_type: "refresh_token",
  }).pipe(Effect.mapError(wrap("Could not reach Google sign-in.")));
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    return Option.none<DriveToken>();
  }
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(TokenResponse)),
    Effect.mapError(wrap("Could not refresh the Google sign-in.")),
  );
  return Option.some(yield* toToken(body, token));
});

/** Best effort: a token Google no longer knows is already as good as revoked. */
export const revokeToken = (token: DriveToken) =>
  postForm(REVOKE_URL, { token: token.refreshToken }).pipe(Effect.ignore);

export const makeDriveRemote = Effect.fn("backup.drive.make")(function* (options: {
  readonly folderName: string;
  /** Yields a valid access token, refreshing and saving it as needed. */
  readonly accessToken: Effect.Effect<string, PluginError>;
}) {
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;

  const authorized = (request: HttpClientRequest.HttpClientRequest) =>
    options.accessToken.pipe(
      Effect.flatMap((token) => client.execute(HttpClientRequest.bearerToken(request, token))),
      Effect.filterOrElse(
        (response) => response.status < 300,
        (response) =>
          response.text.pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((body) =>
              Effect.fail(
                new PluginError({
                  message: `Google Drive answered ${response.status}${body.includes("storageQuotaExceeded") ? ": the Drive is full" : ""}.`,
                }),
              ),
            ),
          ),
      ),
    );

  const json = <A, I>(schema: Schema.Codec<A, I>) => HttpClientResponse.schemaBodyJson(schema);

  /** The backup folder, made on first use. drive.file sees only folders this client made. */
  const folderId = Effect.gen(function* () {
    const query = `mimeType = '${FOLDER_MIME}' and name = ${driveQueryString(options.folderName)} and trashed = false`;
    const found = yield* authorized(
      HttpClientRequest.get(FILES_URL).pipe(
        HttpClientRequest.setUrlParams({ q: query, fields: "files(id,name)", spaces: "drive" }),
      ),
    ).pipe(Effect.flatMap(json(FileList)));
    const existing = found.files[0];
    if (existing !== undefined) return existing.id;
    const created = yield* authorized(
      HttpClientRequest.post(FILES_URL).pipe(
        HttpClientRequest.setUrlParams({ fields: "id" }),
        HttpClientRequest.bodyJsonUnsafe({ name: options.folderName, mimeType: FOLDER_MIME }),
      ),
    ).pipe(Effect.flatMap(json(CreatedFile)));
    return created.id;
  });

  const list = Effect.gen(function* () {
    const parent = yield* folderId;
    const found: Array<RemoteObject> = [];
    let pageToken: string | undefined;
    do {
      const page: typeof FileList.Type = yield* authorized(
        HttpClientRequest.get(FILES_URL).pipe(
          HttpClientRequest.setUrlParams({
            q: `${driveQueryString(parent)} in parents and trashed = false`,
            fields: "nextPageToken,files(id,name,size)",
            pageSize: "1000",
            ...(pageToken === undefined ? {} : { pageToken }),
          }),
        ),
      ).pipe(Effect.flatMap(json(FileList)));
      for (const file of page.files) {
        if (file.name.endsWith(BACKUP_SUFFIX) && parseBackupName(file.name) !== null) {
          found.push({ id: file.id, name: file.name, bytes: Number(file.size ?? 0) });
        }
      }
      pageToken = page.nextPageToken;
    } while (pageToken !== undefined);
    return found;
  }).pipe(Effect.mapError(wrap("Could not list backups in Google Drive.")));

  const upload = Effect.fn("backup.drive.upload")(
    function* (name: string, file: StagedFile) {
      const parent = yield* folderId;
      // A resumable session takes the whole file in one PUT, with no size limit of its own.
      const session = yield* authorized(
        HttpClientRequest.post(UPLOAD_URL).pipe(
          HttpClientRequest.setUrlParams({ uploadType: "resumable" }),
          HttpClientRequest.setHeaders({
            "X-Upload-Content-Type": "application/octet-stream",
            "X-Upload-Content-Length": String(file.bytes),
          }),
          HttpClientRequest.bodyJsonUnsafe({ name, parents: [parent] }),
        ),
      );
      const location = session.headers["location"];
      if (location === undefined) {
        return yield* new PluginError({ message: "Google Drive did not start the upload." });
      }
      const put = yield* HttpClientRequest.bodyFile(file.path, {
        contentType: "application/octet-stream",
      })(
        HttpClientRequest.put(location).pipe(HttpClientRequest.setUrlParams({ fields: "id,size" })),
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      const created = yield* authorized(put).pipe(Effect.flatMap(json(CreatedFile)));
      if (Number(created.size) !== file.bytes) {
        return yield* new PluginError({ message: "Google Drive stored a different size." });
      }
    },
    Effect.mapError(wrap("Could not upload the backup to Google Drive.")),
  );

  return {
    list,
    upload,
    download: (object, destination) =>
      authorized(
        HttpClientRequest.get(`${FILES_URL}/${encodeURIComponent(object.id)}`).pipe(
          HttpClientRequest.setUrlParams({ alt: "media" }),
        ),
      ).pipe(
        Effect.flatMap((response) => Stream.run(response.stream, fs.sink(destination))),
        Effect.mapError(wrap("Could not download the backup from Google Drive.")),
      ),
    remove: (object) =>
      authorized(HttpClientRequest.delete(`${FILES_URL}/${encodeURIComponent(object.id)}`)).pipe(
        Effect.asVoid,
        Effect.mapError(wrap("Could not delete an old backup from Google Drive.")),
      ),
  } satisfies Remote;
});
