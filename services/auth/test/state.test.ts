import { describe, expect, it } from "vitest";
import { createMemoryKv } from "@yyt/redis";
import { createStateStore } from "../src/state.js";

describe("state store", () => {
  it("only one of two concurrent consumers wins", async () => {
    const kv = createMemoryKv();
    const store = createStateStore(kv);
    const state = await store.issue({
      channelId: "c",
      provider: "github",
      redirect: "https://g/",
      nonceHash: "h",
    });
    const results = await Promise.allSettled([
      store.consume(state),
      store.consume(state),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
  it("rejects malformed state without touching redis", async () => {
    const store = createStateStore(createMemoryKv());
    await expect(store.consume("../x")).rejects.toThrow("invalid state");
  });
});
