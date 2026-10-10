import { describe, expect, it } from "vitest";
import {
  isReservedWord,
  PLATFORM_LABEL_NAMES,
  siteNameIssue,
  siteNameProblem,
} from "../src/site-domains.js";

describe("site name classification (docs/decisions.md *Site domains* §3)", () => {
  it("a reserved word is claimable by an admin; labels, tokens and the platform's name by nobody", () => {
    expect(siteNameIssue("help")).toEqual({
      kind: "reserved-word",
      message: "this name is reserved",
    });
    expect(siteNameIssue("docs")?.kind).toBe("reserved-word");
    for (const n of ["api", "dev-g", "console-dev", "my-login", "yyt-help"])
      expect(siteNameIssue(n)?.kind, n).toBe("reserved");
    expect(siteNameIssue("a--b")?.kind).toBe("grammar");
    expect(siteNameIssue("my-game")).toBeUndefined();
    // The member-facing message is the same for both reserved kinds (no oracle).
    expect(siteNameProblem("help")).toBe(siteNameProblem("api"));
  });

  it("no platform label is a reserved word: a label added to both lists stays closed", () => {
    for (const label of PLATFORM_LABEL_NAMES)
      expect(isReservedWord(label), label).toBe(false);
    // `d` and `g` fail the grammar first; every other label is `reserved`.
    for (const label of PLATFORM_LABEL_NAMES)
      expect(siteNameIssue(label)?.kind, label).toBe(
        label.length < 3 ? "grammar" : "reserved",
      );
  });
});
