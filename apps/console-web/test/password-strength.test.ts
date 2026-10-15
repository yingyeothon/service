import cases from "../../../test/fixtures/site-passwords.json";
import { describe, expect, it } from "vitest";
import {
  passwordStrength,
  sitePasswordIssue,
} from "../src/lib/password-strength";
describe("site password guidance", () => {
  it.each(cases)(
    "rates fixture %# locally without using the grade as validation",
    ({ input, valid, grade }) => {
      expect(passwordStrength(input)).toBe(grade);
      expect(sitePasswordIssue(input) === undefined).toBe(valid);
    },
  );
  it("counts Unicode code points and rejects malformed text", () => {
    expect(sitePasswordIssue("🔑".repeat(128))).toBeUndefined();
    expect(sitePasswordIssue("🔑".repeat(129))).toBeDefined();
    expect(sitePasswordIssue("🔑".repeat(3))).toBeDefined();
    expect(sitePasswordIssue("abc\ud800")).toBeDefined();
  });
});
