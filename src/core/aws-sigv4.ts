/**
 * AWS Signature Version 4 (SigV4) request signing.
 *
 * Used by the AssumeRole-by-deployer auth path (Gitea consumers): a
 * long-lived deployer access key signs an STS AssumeRole call to mint
 * short-lived per-env role credentials.
 *
 * Pure implementation using node:crypto — no AWS SDK dependency, matching
 * the existing fetch-based pattern in aws-credentials.ts.
 *
 * Spec reference:
 * https://docs.aws.amazon.com/general/latest/gr/sigv4-create-canonical-request.html
 */

import { createHash, createHmac } from "node:crypto";

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigV4SignParams {
  method: "GET" | "POST" | "PUT" | "DELETE";
  /** Full request URL (https://host/path[?query]). */
  url: string;
  region: string;
  /** AWS service name as used in the credential scope, e.g. "sts". */
  service: string;
  /** Already-encoded request body (e.g. form-encoded). Empty string for no body. */
  body: string;
  /** Optional extra headers; "host" / "x-amz-date" are set automatically. */
  headers?: Record<string, string>;
  credentials: SigV4Credentials;
  /** Override request date — useful for testing. Defaults to now. */
  date?: Date;
}

export interface SignedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export function signRequest(params: SigV4SignParams): SignedRequest {
  const date = params.date ?? new Date();
  const amzDate = formatAmzDate(date);
  const dateStamp = amzDate.slice(0, 8);

  const url = new URL(params.url);
  const path = url.pathname || "/";
  const queryString = url.searchParams.toString();

  // Header table the signer will hash. Lower-cased keys per spec.
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-date": amzDate,
  };
  if (params.credentials.sessionToken) {
    headers["x-amz-security-token"] = params.credentials.sessionToken;
  }
  for (const [key, value] of Object.entries(params.headers ?? {})) {
    headers[key.toLowerCase()] = value;
  }

  const sortedHeaderKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k].trim()}\n`).join("");
  const signedHeaders = sortedHeaderKeys.join(";");

  const payloadHash = sha256Hex(params.body);

  const canonicalRequest = [params.method, path, queryString, canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const credentialScope = `${dateStamp}/${params.region}/${params.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmacSha256(`AWS4${params.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, params.region);
  const kService = hmacSha256(kRegion, params.service);
  const kSigning = hmacSha256(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${params.credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: params.url,
    method: params.method,
    headers: { ...headers, Authorization: authorization },
    body: params.body,
  };
}

/** "2023-12-15T12:34:56.789Z" → "20231215T123456Z" */
function formatAmzDate(d: Date): string {
  return `${d
    .toISOString()
    .replace(/[:-]/g, "")
    .replace(/\.\d{3}/, "")}`;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}
