import { describe, expect, it } from "vitest";
import { isNavActive } from "../src/navigation";

describe("isNavActive", () => {
  it("matches home exactly and sections by segment boundary", () => {
    expect(isNavActive("/", "/")).toBe(true);
    expect(isNavActive("/events", "/")).toBe(false);
    expect(isNavActive("/events", "/events")).toBe(true);
    expect(isNavActive("/events/ev_1", "/events")).toBe(true);
    expect(isNavActive("/eventsX", "/events")).toBe(false);
  });
});
