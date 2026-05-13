import { describe, expect, it } from "vitest";
import { signRequest } from "./aws-sigv4.js";

const FIXED_DATE = new Date("2026-05-04T12:34:56.000Z");
const TEST_CREDS = {
  accessKeyId: "AKIA_DEPLOYER_DEV",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const STS_BODY =
  "Action=AssumeRole&Version=2011-06-15&RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Fdeploy-app" +
  "&RoleSessionName=test-session&DurationSeconds=3600";

describe("signRequest", () => {
  it("produces an Authorization header in the AWS4-HMAC-SHA256 format", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      credentials: TEST_CREDS,
      date: FIXED_DATE,
    });

    expect(signed.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA_DEPLOYER_DEV\/20260504\/us-east-1\/sts\/aws4_request, SignedHeaders=[a-z;-]+, Signature=[a-f0-9]{64}$/,
    );
  });

  it("signs the same input deterministically", () => {
    const signed1 = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      credentials: TEST_CREDS,
      date: FIXED_DATE,
    });
    const signed2 = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      credentials: TEST_CREDS,
      date: FIXED_DATE,
    });
    expect(signed1.headers.Authorization).toBe(signed2.headers.Authorization);
  });

  it("produces a different signature when the secret changes", () => {
    const a = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      credentials: TEST_CREDS,
      date: FIXED_DATE,
    });
    const b = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      credentials: { ...TEST_CREDS, secretAccessKey: "DIFFERENT_SECRET" },
      date: FIXED_DATE,
    });
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it("produces a different signature when the date changes", () => {
    const a = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      credentials: TEST_CREDS,
      date: FIXED_DATE,
    });
    const b = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      credentials: TEST_CREDS,
      date: new Date("2026-05-05T12:34:56.000Z"),
    });
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it("includes x-amz-security-token in headers and SignedHeaders when sessionToken is present", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      credentials: { ...TEST_CREDS, sessionToken: "FwoGZXIvYXdzEJX//session-token//" },
      date: FIXED_DATE,
    });

    expect(signed.headers["x-amz-security-token"]).toBe("FwoGZXIvYXdzEJX//session-token//");
    expect(signed.headers.Authorization).toMatch(/SignedHeaders=[^,]*x-amz-security-token/);
  });

  it("omits x-amz-security-token when no sessionToken provided", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      credentials: TEST_CREDS,
      date: FIXED_DATE,
    });
    expect(signed.headers["x-amz-security-token"]).toBeUndefined();
    expect(signed.headers.Authorization).not.toMatch(/x-amz-security-token/);
  });

  it("sets x-amz-date header in compact ISO8601 format", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      credentials: TEST_CREDS,
      date: FIXED_DATE,
    });
    expect(signed.headers["x-amz-date"]).toBe("20260504T123456Z");
  });

  it("preserves body and method on the signed request", () => {
    const signed = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      credentials: TEST_CREDS,
      date: FIXED_DATE,
    });
    expect(signed.method).toBe("POST");
    expect(signed.body).toBe(STS_BODY);
  });

  it("varies the credential scope by region", () => {
    const a = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "us-east-1",
      service: "sts",
      body: STS_BODY,
      credentials: TEST_CREDS,
      date: FIXED_DATE,
    });
    const b = signRequest({
      method: "POST",
      url: "https://sts.amazonaws.com/",
      region: "eu-central-1",
      service: "sts",
      body: STS_BODY,
      credentials: TEST_CREDS,
      date: FIXED_DATE,
    });
    expect(a.headers.Authorization).toMatch(/\/us-east-1\/sts\/aws4_request/);
    expect(b.headers.Authorization).toMatch(/\/eu-central-1\/sts\/aws4_request/);
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });
});
