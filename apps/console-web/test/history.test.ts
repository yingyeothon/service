import { describe, expect, it } from "vitest";
import { historyDetail } from "../src/components/HistoryList";

describe("historyDetail", () => {
  it("flattens field names, roles and resource labels only", () => {
    expect(historyDetail(null)).toBe("");
    expect(
      historyDetail({
        fields: ["name", "description"],
        role: "owner",
        resource: { kind: "channel", id: "auth_1", name: "login" },
        nothing: null,
      }),
    ).toBe("fields: name, description · role: owner · channel login");
  });
});
