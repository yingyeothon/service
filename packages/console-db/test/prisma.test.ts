import { AppError } from "@yyt/core";
import { describe, expect, it } from "vitest";
import {
  createPrismaClient,
  mysqlOptionsFromEnv,
  run,
  translatePrismaError,
} from "../src/prisma.js";

describe("mysqlOptionsFromEnv", () => {
  const env = {
    MYSQL_HOST: "localhost",
    MYSQL_PORT: "3307",
    MYSQL_DATABASE: "d",
    MYSQL_USER: "u",
    MYSQL_PASSWORD: "p",
  };
  it("reads the MYSQL_* layout", () => {
    expect(mysqlOptionsFromEnv(env)).toEqual({
      host: "localhost",
      port: 3307,
      database: "d",
      user: "u",
      password: "p",
    });
  });
  it("defaults the port and honours a prefix", () => {
    expect(
      mysqlOptionsFromEnv(
        {
          DEBUG_MYSQL_HOST: "h",
          DEBUG_MYSQL_DATABASE: "d",
          DEBUG_MYSQL_USER: "u",
          DEBUG_MYSQL_PASSWORD: "p",
        },
        "DEBUG_MYSQL_",
      ).port,
    ).toBe(3306);
  });
  it("rejects missing values and bad ports without echoing values", () => {
    expect(() => mysqlOptionsFromEnv({ ...env, MYSQL_HOST: "" })).toThrow(
      /missing env MYSQL_HOST/,
    );
    expect(() => mysqlOptionsFromEnv({ ...env, MYSQL_PORT: "nope" })).toThrow(
      /MYSQL_PORT must be a positive integer/,
    );
  });
});

describe("createPrismaClient", () => {
  it("constructs lazily without connecting", async () => {
    const client = createPrismaClient({
      host: "127.0.0.1",
      port: 1, // nothing listens here; construction must not connect
      database: "d",
      user: "u",
      password: "p",
    });
    expect(client).toBeDefined();
    await client.$disconnect();
  });
});

describe("translatePrismaError / run", () => {
  it("maps P2002 to conflict and keeps only the code in the cause", async () => {
    const raw = Object.assign(new Error(`Unique failed on 'secret-value'`), {
      code: "P2002",
    });
    const err = await run(() => Promise.reject(raw)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("conflict");
    expect(JSON.stringify(err)).not.toContain("secret-value");
  });
  it("maps everything else to unavailable with `prisma <code>`", () => {
    try {
      translatePrismaError(Object.assign(new Error("x"), { code: "P2003" }));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe("unavailable");
      expect(((e as AppError).cause as Error).message).toBe("prisma P2003");
    }
    try {
      translatePrismaError("boom");
      expect.unreachable();
    } catch (e) {
      expect(((e as AppError).cause as Error).message).toBe("prisma unknown");
    }
  });
  it("rethrows AppError untouched", async () => {
    const original = new AppError("bad_request", "nope");
    await expect(run(() => Promise.reject(original))).rejects.toBe(original);
  });
});
