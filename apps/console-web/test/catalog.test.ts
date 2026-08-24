import { describe, expect, it } from "vitest";
import {
  artifactVersion,
  fmtSize,
  groupArtifactsByVersion,
  isIosUserAgent,
} from "../src/lib/catalog";
import type { CatalogArtifact } from "../src/types";

const mk = (
  id: string,
  version: string | undefined,
  createdAt: number,
): CatalogArtifact => ({
  id,
  appId: "a1",
  platform: "android",
  url: `https://d/x/${id}`,
  objectKey: `x/${id}`,
  size: 1,
  hash: null,
  tags: version === undefined ? {} : { version },
  createdAt,
});

describe("groupArtifactsByVersion", () => {
  it("groups by version tag, newest group and artifact first", () => {
    const groups = groupArtifactsByVersion([
      mk("a", "1.0", 100),
      mk("b", "2.0", 200),
      mk("c", "2.0", 250),
      mk("d", undefined, 300),
    ]);
    expect(groups.map((g) => g.version)).toEqual(["unknown", "2.0", "1.0"]);
    expect(groups[1]!.artifacts.map((a) => a.id)).toEqual(["c", "b"]);
    expect(artifactVersion(mk("x", "  ", 0))).toBe("unknown");
  });
});

describe("fmtSize", () => {
  it("formats bytes", () => {
    expect(fmtSize(null)).toBe("—");
    expect(fmtSize(512)).toBe("512 B");
    expect(fmtSize(2048)).toBe("2.0 KB");
    expect(fmtSize(66_824_152)).toBe("64 MB");
  });
});

describe("isIosUserAgent", () => {
  it("detects iPhones/iPads only", () => {
    expect(
      isIosUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"),
    ).toBe(true);
    expect(isIosUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X)")).toBe(
      false,
    );
  });
});
