// @effect-diagnostics nodeBuiltinImport:off -- Synchronous HMAC and SHA-256 for request signing; Effect's crypto is effectful and async.
// AWS Signature Version 4 for S3-compatible services, with node:crypto only.
// https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
import * as NodeCrypto from "node:crypto";

import * as DateTime from "effect/DateTime";

export const EMPTY_PAYLOAD_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface SigV4Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export interface SigV4Input {
  readonly method: string;
  readonly url: URL;
  /** Headers to sign besides host and x-amz-date, which are added. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the body, or "UNSIGNED-PAYLOAD". */
  readonly payloadHash: string;
  readonly region: string;
  readonly service: string;
  readonly credentials: SigV4Credentials;
  /** Epoch milliseconds. */
  readonly now: number;
}

export interface SigV4Result {
  /** Every header to send, lower-cased, including authorization. */
  readonly headers: Record<string, string>;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

const sha256Hex = (data: string) => NodeCrypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) =>
  NodeCrypto.createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding: everything but unreserved characters, as AWS requires. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** S3 encodes each path segment once and does not normalize the path. */
function canonicalPath(url: URL): string {
  const path = url.pathname === "" ? "/" : url.pathname;
  return path
    .split("/")
    .map((segment) => uriEncode(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(url: URL): string {
  return [...url.searchParams]
    .map(([key, value]) => [uriEncode(key), uriEncode(value)] as const)
    .sort(([a, aValue], [b, bValue]) =>
      a < b ? -1 : a > b ? 1 : aValue < bValue ? -1 : aValue > bValue ? 1 : 0,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** `20150830T123600Z` */
export function amzDate(epochMs: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(epochMs))
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function signingKey(secret: string, date: string, region: string, service: string) {
  const dateKey = hmac(`AWS4${secret}`, date);
  return hmac(hmac(hmac(dateKey, region), service), "aws4_request");
}

export function signV4(input: SigV4Input): SigV4Result {
  const timestamp = amzDate(input.now);
  const date = timestamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }
  headers.host ??= input.url.host;
  headers["x-amz-date"] = timestamp;
  if (input.credentials.sessionToken !== undefined) {
    headers["x-amz-security-token"] = input.credentials.sessionToken;
  }

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names
    .map((name) => `${name}:${headers[name]!.trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(input.url),
    canonicalQuery(input.url),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha256Hex(canonicalRequest)].join(
    "\n",
  );
  const signature = NodeCrypto.createHmac(
    "sha256",
    signingKey(input.credentials.secretAccessKey, date, input.region, input.service),
  )
    .update(stringToSign)
    .digest("hex");

  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalRequest, stringToSign, signature };
}
