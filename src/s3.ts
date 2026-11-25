import { PluginError } from "@t3tools/plugin-api";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { S3Settings } from "./actions.ts";
import { BACKUP_SUFFIX, parseBackupName } from "./backups.ts";
import type { Remote, RemoteObject } from "./remote.ts";
import { EMPTY_PAYLOAD_SHA256, signV4, uriEncode } from "./sigv4.ts";

export interface S3Config extends S3Settings {
  readonly secretAccessKey: string;
}

/** The URL for a key, or for the bucket itself when `key` is omitted. Null if the endpoint is not a URL. */
export function objectUrl(config: S3Config, key?: string): URL | null {
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint.trim());
  } catch {
    return null;
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") return null;
  const encodedKey = key === undefined ? "" : key.split("/").map(uriEncode).join("/");
  const base = endpoint.pathname.replace(/\/+$/, "");
  if (config.forcePathStyle) {
    return new URL(`${endpoint.origin}${base}/${uriEncode(config.bucket)}/${encodedKey}`);
  }
  return new URL(`${endpoint.protocol}//${config.bucket}.${endpoint.host}${base}/${encodedKey}`);
}

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const unescapeXml = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity] ?? whole;
  });

const tag = (xml: string, name: string) => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match === null ? null : unescapeXml(match[1]!);
};

/** The parts of a ListObjectsV2 response this plugin reads. */
export function parseListObjectsV2(xml: string): {
  readonly objects: ReadonlyArray<{ readonly key: string; readonly size: number }>;
  readonly nextContinuationToken: string | null;
} {
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].flatMap((match) => {
    const key = tag(match[1]!, "Key");
    const size = Number(tag(match[1]!, "Size"));
    return key === null || !Number.isFinite(size) ? [] : [{ key, size }];
  });
  return {
    objects,
    nextContinuationToken:
      tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : null,
  };
}

/** S3's `<Error><Code>` and `<Message>`, for a message people can act on. */
export function describeS3Error(status: number, body: string): string {
  const code = tag(body, "Code");
  const message = tag(body, "Message");
  if (code === null) return `The storage service answered ${status}.`;
  return `The storage service answered ${status} ${code}${message ? `: ${message}` : ""}.`;
}

export function validateS3Config(config: S3Config): string | null {
  if (objectUrl(config) === null) return "Set the S3 endpoint to an http(s) URL.";
  if (config.bucket.trim() === "") return "Set the S3 bucket.";
  if (config.region.trim() === "") return "Set the S3 region (R2 uses auto).";
  if (config.accessKeyId === "" || config.secretAccessKey === "") {
    return "Set the S3 access key and secret.";
  }
  return null;
}

export const makeS3Remote = Effect.fn("backup.s3.make")(function* (config: S3Config) {
  const problem = validateS3Config(config);
  if (problem !== null) return yield* new PluginError({ message: problem });
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const credentials = {
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
  };

  const send = Effect.fn("backup.s3.send")(function* (
    method: "GET" | "PUT" | "DELETE",
    url: URL,
    options: { readonly payloadHash?: string; readonly file?: string } = {},
  ) {
    const payloadHash = options.payloadHash ?? EMPTY_PAYLOAD_SHA256;
    const signed = signV4({
      method,
      url,
      headers: { "x-amz-content-sha256": payloadHash },
      payloadHash,
      region: config.region.trim(),
      service: "s3",
      credentials,
      now: yield* Clock.currentTimeMillis,
    });
    // fetch sets Host from the URL itself, which is what was signed.
    const { host: _host, ...headers } = signed.headers;
    let request = HttpClientRequest.make(method)(url).pipe(HttpClientRequest.setHeaders(headers));
    if (options.file !== undefined) {
      request = yield* HttpClientRequest.bodyFile(options.file, {
        contentType: "application/octet-stream",
      })(request).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    }
    const response = yield* client.execute(request);
    if (response.status >= 300) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* new PluginError({ message: describeS3Error(response.status, body) });
    }
    return response;
  });

  const isPluginError = Schema.is(PluginError);
  const fail = (message: string) => (cause: unknown) =>
    isPluginError(cause) ? cause : new PluginError({ message, cause });
  const keyOf = (name: string) => `${config.prefix}${name}`;

  const list = Effect.gen(function* () {
    const found: Array<RemoteObject> = [];
    let token: string | null = null;
    do {
      const url = objectUrl(config)!;
      url.searchParams.set("list-type", "2");
      if (config.prefix !== "") url.searchParams.set("prefix", config.prefix);
      if (token !== null) url.searchParams.set("continuation-token", token);
      const response: HttpClientResponse.HttpClientResponse = yield* send("GET", url);
      const page = parseListObjectsV2(yield* response.text);
      for (const object of page.objects) {
        const name = object.key.slice(config.prefix.length);
        if (name.endsWith(BACKUP_SUFFIX) && parseBackupName(name) !== null) {
          found.push({ id: object.key, name, bytes: object.size });
        }
      }
      token = page.nextContinuationToken;
    } while (token !== null);
    return found;
  }).pipe(Effect.mapError(fail("Could not list backups in the bucket.")));

  return {
    list,
    upload: (name, file) =>
      send("PUT", objectUrl(config, keyOf(name))!, {
        payloadHash: file.sha256,
        file: file.path,
      }).pipe(Effect.asVoid, Effect.mapError(fail("Could not upload the backup."))),
    download: (object, destination) =>
      send("GET", objectUrl(config, object.id)!).pipe(
        Effect.flatMap((response) => Stream.run(response.stream, fs.sink(destination))),
        Effect.mapError(fail("Could not download the backup.")),
      ),
    remove: (object) =>
      send("DELETE", objectUrl(config, object.id)!).pipe(
        Effect.asVoid,
        Effect.mapError(fail("Could not delete an old backup.")),
      ),
  } satisfies Remote;
});
