import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { SIGNATURE_HEADER, signCallback } from "../src/signature.js";
import { createTopicLobbyHandler } from "../src/topicLobby.js";

const apiKey = "match-key";
const callback = JSON.stringify({
  matchId: "m_9",
  channelId: "match_x",
  members: [{ userId: "u1" }, { userId: "u2" }],
  partial: true,
});
const signed = (body: string, signature = signCallback(body, apiKey)) =>
  ({
    headers: { [SIGNATURE_HEADER]: signature },
    body,
  }) as unknown as APIGatewayProxyEventV2;

function setup(status = 201) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const handler = createTopicLobbyHandler({
    matchApiKey: apiKey,
    topicBaseUrl: "https://topic.example",
    topicApiKey: "topic-key",
    ttlSec: 60,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          topicId: "t1",
          wsUrl: "wss://topic-ws.example/?topic=t1",
        }),
        { status },
      );
    }) as unknown as typeof fetch,
  });
  return { handler, calls };
}

describe("topic lobby", () => {
  it("opens a room for exactly the party and returns its wsUrl", async () => {
    const { handler, calls } = setup();
    const res = (await handler(signed(callback))) as {
      statusCode: number;
      body: string;
    };
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      wsUrl: "wss://topic-ws.example/?topic=t1",
      topicId: "t1",
      gameId: "m_9",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://topic.example/t");
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer topic-key",
    });
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      allowUserIds: ["u1", "u2"],
      ttlSec: 60,
    });
  });
  it("rejects a bad signature without calling the topic service", async () => {
    const { handler, calls } = setup();
    const res = await handler(signed(callback, "nope"));
    expect(res).toMatchObject({ statusCode: 401 });
    expect(calls).toEqual([]);
  });
  it("maps a topic failure to 502 so the matchmaker reports failed/callback", async () => {
    const { handler } = setup(401);
    expect(await handler(signed(callback))).toMatchObject({ statusCode: 502 });
  });
});
