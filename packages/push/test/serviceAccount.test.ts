import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_TOKEN_URI,
  parseServiceAccount,
  ServiceAccountError,
  SERVICE_ACCOUNT_MAX_CHARS,
} from "../src/index.js";
import { accountJson, testKey } from "./helpers.js";

const reasonOf = (json: string): string => {
  try {
    parseServiceAccount(json);
  } catch (e) {
    expect(e).toBeInstanceOf(ServiceAccountError);
    const err = e as ServiceAccountError;
    expect(err.message).toBe(`invalid service account: ${err.reason}`);
    return err.reason;
  }
  throw new Error("accepted");
};

describe("parseServiceAccount", () => {
  it("accepts Google's key file and never serialises the key", () => {
    const account = parseServiceAccount(accountJson());
    expect(account.projectId).toBe("example-project");
    expect(account.clientEmail).toBe(
      "sender@example-project.iam.gserviceaccount.com",
    );
    expect(account.privateKeyId).toBe("0123456789abcdef");
    expect(account.tokenUri).toBe(GOOGLE_TOKEN_URI);
    expect(account.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    const dumped = JSON.stringify(account);
    expect(dumped).not.toContain("PRIVATE KEY");
    expect(dumped).toContain('"privateKey":{}');
  });

  it("defaults token_uri and leaves out an absent key id", () => {
    const account = parseServiceAccount(
      accountJson({ token_uri: undefined, private_key_id: undefined }),
    );
    expect(account.tokenUri).toBe(GOOGLE_TOKEN_URI);
    expect("privateKeyId" in account).toBe(false);
    // Same key, same fingerprint, whatever the file says about ids.
    expect(account.fingerprint).toBe(
      parseServiceAccount(accountJson()).fingerprint,
    );
  });

  it("names the refused field", () => {
    expect(reasonOf("{")).toBe("not_json");
    expect(reasonOf("[]")).toBe("not_object");
    expect(reasonOf('"x"')).toBe("not_object");
    expect(reasonOf("x".repeat(SERVICE_ACCOUNT_MAX_CHARS + 1))).toBe(
      "too_large",
    );
    expect(reasonOf(accountJson({ project_id: "Bad/Project" }))).toBe(
      "project_id",
    );
    expect(reasonOf(accountJson({ project_id: 7 }))).toBe("project_id");
    expect(reasonOf(accountJson({ client_email: "no-at-sign" }))).toBe(
      "client_email",
    );
    expect(reasonOf(accountJson({ client_email: undefined }))).toBe(
      "client_email",
    );
    expect(reasonOf(accountJson({ private_key_id: "a b" }))).toBe(
      "private_key_id",
    );
    expect(reasonOf(accountJson({ private_key_id: 1 }))).toBe("private_key_id");
    expect(reasonOf(accountJson({ private_key: undefined }))).toBe(
      "private_key",
    );
    expect(reasonOf(accountJson({ private_key: "not a pem" }))).toBe(
      "private_key",
    );
  });

  it("refuses a token endpoint that is not Google's", () => {
    expect(
      reasonOf(accountJson({ token_uri: "https://attacker.example/token" })),
    ).toBe("token_uri");
    expect(reasonOf(accountJson({ token_uri: 5 }))).toBe("token_uri");
  });

  it("refuses a key that is not RSA", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(reasonOf(accountJson({ private_key: ec }))).toBe("private_key");
  });

  it("never echoes the input in an error", () => {
    const body = testKey().pem.split("\n")[1]!;
    for (const bad of [
      accountJson().slice(0, -2),
      accountJson({ private_key: testKey().pem.replace("A", "!!") }),
      accountJson({ project_id: "SECRET-MARKER" }),
    ]) {
      try {
        parseServiceAccount(bad);
      } catch (e) {
        const text = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack}`;
        expect(text).not.toContain(body);
        expect(text).not.toContain("SECRET-MARKER");
        expect((e as Error).cause).toBeUndefined();
      }
    }
  });
});
