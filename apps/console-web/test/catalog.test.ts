import { describe, expect, it } from "vitest";
import {
  artifactLabel,
  artifactLabels,
  artifactTagRows,
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

describe("artifactTagRows", () => {
  it("orders the known tags and appends unknown ones alphabetically", () => {
    const a = mk("a", "1.0", 0);
    a.tags = {
      sha256: "ff",
      commit: "abc1234",
      build_type: "release",
      version: "1.0",
      zeta: "z",
      alpha: "a",
    };
    expect(artifactTagRows(a).map((t) => t.key)).toEqual([
      "version",
      "build_type",
      "commit",
      "sha256",
      "alpha",
      "zeta",
    ]);
  });

  it("is empty when the upload sent no tags", () => {
    expect(artifactTagRows(mk("a", undefined, 0))).toEqual([]);
  });
});

describe("artifactLabel", () => {
  it("tells per-ABI rows of one version apart", () => {
    const a = mk("a", "1.0", 0);
    a.tags = { version: "1.0", abi: "arm64-v8a" };
    expect(artifactLabel(a, "1.0")).toBe("1.0 android arm64-v8a");
    const b = mk("b", "1.0", 0);
    b.objectKey = "apps/ca_1/1.0/app.apk";
    expect(artifactLabel(b, "1.0")).toBe("1.0 android app.apk");
    const c = mk("c", "1.0", 0);
    c.objectKey = null;
    expect(artifactLabel(c, "1.0")).toBe("1.0 android");
  });
});

describe("artifactLabels", () => {
  it("appends the id only where a label repeats", () => {
    const one = { ...mk("a", "1.0", 0), version: "1.0" };
    const two = {
      ...mk("b", "1.0", 0),
      objectKey: "p/x/a.apk",
      version: "1.0",
    };
    const three = {
      ...mk("c", "1.0", 0),
      objectKey: "p/y/a.apk",
      version: "1.0",
    };
    const labels = artifactLabels([one, two, three]);
    expect(labels.get("a")).toBe("1.0 android a");
    expect(labels.get("b")).toBe("1.0 android a.apk b");
    expect(labels.get("c")).toBe("1.0 android a.apk c");
  });
});
