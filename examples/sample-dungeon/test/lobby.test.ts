import type { GameActorStartEvent } from "@yingyeothon/lambda-gamebase";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { createLobbyHandler, toStartEvent } from "../src/lobby.js";
import { SIGNATURE_HEADER, signCallback } from "../src/signature.js";

const apiKey = "match-api-key";

function request(
  body: string,
  { signature = signCallback(body, apiKey), base64 = false } = {},
): APIGatewayProxyEventV2 {
  return {
    headers: { [SIGNATURE_HEADER]: signature },
    body: base64 ? Buffer.from(body).toString("base64") : body,
    isBase64Encoded: base64,
  } as unknown as APIGatewayProxyEventV2;
}

function setup() {
  const saved: GameActorStartEvent[] = [];
  const started: GameActorStartEvent[] = [];
  const handler = createLobbyHandler({
    matchApiKey: apiKey,
    wsUrl: "wss://game.example/dev",
    saveStartEvent: async (e) => {
      saved.push(e);
    },
    startActor: async (e) => {
      started.push(e);
    },
  });
  return { handler, saved, started };
}

const callback = JSON.stringify({
  matchId: "m_1",
  channelId: "match_x",
  members: [{ userId: "u1" }, { userId: "u2" }],
  partial: false,
});

describe("match callback", () => {
  it("saves the start event, starts the actor, returns wsUrl + gameId", async () => {
    const { handler, saved, started } = setup();
    const res = await handler(request(callback));
    expect(res).toMatchObject({ statusCode: 200 });
    expect(JSON.parse((res as { body: string }).body)).toEqual({
      wsUrl: "wss://game.example/dev",
      gameId: "m_1",
    });
    expect(saved).toHaveLength(1);
    expect(started).toEqual(saved);
    // sub === memberId: both are the auth userId.
    expect(saved[0]?.members.map((m) => m.memberId)).toEqual(["u1", "u2"]);
    expect(saved[0]?.callbackUrl).toBeUndefined();
  });

  it("verifies the signature over the raw (base64-decoded) body", async () => {
    const { handler, started } = setup();
    const res = await handler(request(callback, { base64: true }));
    expect(res).toMatchObject({ statusCode: 200 });
    expect(started).toHaveLength(1);
  });

  it("rejects a bad signature before touching anything", async () => {
    const { handler, saved, started } = setup();
    const res = await handler(request(callback, { signature: "deadbeef" }));
    expect(res).toMatchObject({ statusCode: 401 });
    expect(saved).toEqual([]);
    expect(started).toEqual([]);
  });

  it("rejects malformed bodies that were properly signed", async () => {
    const { handler, started } = setup();
    for (const bad of [
      "not json",
      JSON.stringify({
        matchId: "",
        channelId: "c",
        members: [{ userId: "u" }],
      }),
      JSON.stringify({ matchId: "m", channelId: "c", members: [] }),
      JSON.stringify({
        matchId: "m",
        channelId: "c",
        members: [{ userId: 1 }],
      }),
    ]) {
      const res = await handler(request(bad));
      expect(res).toMatchObject({ statusCode: 400 });
    }
    expect(started).toEqual([]);
  });

  it("saves before starting so $connect never races the actor", async () => {
    const order: string[] = [];
    const handler = createLobbyHandler({
      matchApiKey: apiKey,
      wsUrl: "wss://x",
      saveStartEvent: async () => {
        order.push("save");
      },
      startActor: async () => {
        order.push("start");
      },
    });
    await handler(request(callback));
    expect(order).toEqual(["save", "start"]);
    expect(vi.isMockFunction(handler)).toBe(false);
  });

  it("maps members without inventing PII", () => {
    const e = toStartEvent({
      matchId: "m",
      channelId: "c",
      members: [{ userId: "u" }],
      partial: true,
    });
    expect(e.members).toEqual([{ memberId: "u", name: "u", email: "" }]);
  });
});
