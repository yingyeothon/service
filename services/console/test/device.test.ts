import { describe, expect, it } from "vitest";
import { ev, harness } from "./helpers.js";

const JSON_H = { headers: { "content-type": "application/json" } };
const j = (r: { body?: string }) => JSON.parse(r.body ?? "{}") as never;

function interceptDeviceStart(h: ReturnType<typeof harness>) {
  h.agent
    .get("https://github.com")
    .intercept({ path: "/login/device/code", method: "POST" })
    .reply(
      200,
      {
        device_code: "dc_secret",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      },
      JSON_H,
    );
}

function interceptPoll(h: ReturnType<typeof harness>, body: object) {
  h.agent
    .get("https://github.com")
    .intercept({ path: "/login/oauth/access_token", method: "POST" })
    .reply(200, body, JSON_H);
}

describe("device flow", () => {
  it("start returns a handle and never exposes the device code", async () => {
    const h = harness();
    interceptDeviceStart(h);
    const r = await h.app(ev("POST", "/auth/device/start"));
    expect(r.statusCode).toBe(201);
    const d = j(r) as { handle: string; userCode: string };
    expect(d.handle).toMatch(/^dev_[0-9a-f]{32}$/);
    expect(d.userCode).toBe("ABCD-1234");
    expect(r.body).not.toContain("dc_secret");
  });

  it("polls pending → throttled → issues a console token on approval", async () => {
    const h = harness();
    interceptDeviceStart(h);
    const { handle } = j(await h.app(ev("POST", "/auth/device/start"))) as {
      handle: string;
    };

    interceptPoll(h, { error: "authorization_pending" });
    const p1 = await h.app(
      ev("POST", "/auth/device/token", { body: { handle } }),
    );
    expect(p1.statusCode).toBe(202);

    // Immediate second poll is throttled locally (no GitHub call mocked).
    const p2 = await h.app(
      ev("POST", "/auth/device/token", { body: { handle } }),
    );
    expect(p2.statusCode).toBe(429);

    h.clock.tick(6);
    interceptPoll(h, { access_token: "gho_dev" });
    h.agent
      .get("https://api.github.com")
      .intercept({ path: "/user", method: "GET" })
      .reply(200, { id: 4242, login: "cli-user" }, JSON_H);
    const ok = await h.app(
      ev("POST", "/auth/device/token", {
        body: { handle, tokenName: "my-laptop" },
      }),
    );
    expect(ok.statusCode).toBe(201);
    const d = j(ok) as {
      status: string;
      token: string;
      member: { login: string; role: string };
    };
    expect(d.status).toBe("ok");
    expect(d.token).toMatch(/^yyt_[0-9a-f]{48}$/);
    expect(d.member).toMatchObject({ login: "cli-user", role: "pending" });

    // The minted token authenticates as a bearer.
    const me = await h.app(
      ev("GET", "/me", { headers: { authorization: `Bearer ${d.token}` } }),
    );
    expect(me.statusCode).toBe(200);
    expect(j(me)).toMatchObject({ login: "cli-user", via: "token" });

    // Handle is single-use.
    const reuse = await h.app(
      ev("POST", "/auth/device/token", { body: { handle } }),
    );
    expect(reuse.statusCode).toBe(410);
  });

  it("denied and expired polls drop the handle", async () => {
    const h = harness();
    for (const [error, status] of [
      ["access_denied", 403],
      ["expired_token", 410],
    ] as const) {
      interceptDeviceStart(h);
      const { handle } = j(await h.app(ev("POST", "/auth/device/start"))) as {
        handle: string;
      };
      interceptPoll(h, { error });
      const r = await h.app(
        ev("POST", "/auth/device/token", { body: { handle } }),
      );
      expect(r.statusCode).toBe(status);
      const again = await h.app(
        ev("POST", "/auth/device/token", { body: { handle } }),
      );
      expect(again.statusCode).toBe(410);
    }
  });

  it("bad handles are rejected without a github call", async () => {
    const h = harness();
    expect(
      (
        await h.app(
          ev("POST", "/auth/device/token", { body: { handle: "dev_zz" } }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await h.app(
          ev("POST", "/auth/device/token", {
            body: { handle: `dev_${"0".repeat(32)}` },
          }),
        )
      ).statusCode,
    ).toBe(410);
  });
});
