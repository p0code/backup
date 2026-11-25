import { describe, expect, it } from "vite-plus/test";

import { EMPTY_PAYLOAD_SHA256, signV4 } from "./sigv4.ts";

// AWS's published SigV4 test suite (aws-sig-v4-test-suite, as shipped with botocore and
// the AWS SDKs): fixed credentials, region us-east-1, service "service".
const SUITE = {
  credentials: {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  },
  region: "us-east-1",
  service: "service",
  now: Date.UTC(2015, 7, 30, 12, 36),
};

describe("SigV4 test suite", () => {
  it("get-vanilla", () => {
    const result = signV4({
      ...SUITE,
      method: "GET",
      url: new URL("https://example.amazonaws.com/"),
      payloadHash: EMPTY_PAYLOAD_SHA256,
    });
    expect(result.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        EMPTY_PAYLOAD_SHA256,
      ].join("\n"),
    );
    expect(result.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/service/aws4_request",
        "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
      ].join("\n"),
    );
    expect(result.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("get-vanilla-query-order-key-case", () => {
    const result = signV4({
      ...SUITE,
      method: "GET",
      url: new URL("https://example.amazonaws.com/?Param2=value2&Param1=value1"),
      payloadHash: EMPTY_PAYLOAD_SHA256,
    });
    expect(result.canonicalRequest.split("\n")[2]).toBe("Param1=value1&Param2=value2");
    expect(result.signature).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });
});

// The worked examples in the S3 API reference, "Signature Calculations for the
// Authorization Header: Transferring Payload in a Single Chunk".
const S3 = {
  credentials: {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  },
  region: "us-east-1",
  service: "s3",
  now: Date.UTC(2013, 4, 24),
};

describe("S3 reference examples", () => {
  it("GET object with a range", () => {
    const result = signV4({
      ...S3,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { Range: "bytes=0-9", "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256 },
      payloadHash: EMPTY_PAYLOAD_SHA256,
    });
    expect(result.signature).toBe(
      "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("PUT object", () => {
    const payloadHash = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
    const result = signV4({
      ...S3,
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test$file.text"),
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
        "x-amz-content-sha256": payloadHash,
      },
      payloadHash,
    });
    expect(result.canonicalRequest.split("\n")[1]).toBe("/test%24file.text");
    expect(result.signature).toBe(
      "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("GET bucket lifecycle", () => {
    const result = signV4({
      ...S3,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?lifecycle"),
      headers: { "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256 },
      payloadHash: EMPTY_PAYLOAD_SHA256,
    });
    expect(result.signature).toBe(
      "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    );
  });

  it("GET bucket (list objects)", () => {
    const result = signV4({
      ...S3,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J"),
      headers: { "x-amz-content-sha256": EMPTY_PAYLOAD_SHA256 },
      payloadHash: EMPTY_PAYLOAD_SHA256,
    });
    expect(result.signature).toBe(
      "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("session tokens", () => {
  it("signs the security token header", () => {
    const result = signV4({
      ...S3,
      credentials: { ...S3.credentials, sessionToken: "token" },
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/"),
      payloadHash: EMPTY_PAYLOAD_SHA256,
    });
    expect(result.headers["x-amz-security-token"]).toBe("token");
    expect(result.headers.authorization).toContain("host;x-amz-date;x-amz-security-token");
  });
});
