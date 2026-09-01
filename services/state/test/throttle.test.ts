import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The stage throttle, read from serverless.yml (no yaml dependency).
 *
 * Serverless 4 has no `provider.httpApi.defaultRouteSettings`: it warns
 * ("unrecognized property") and deploys the stage with no throttle at all.
 * This stack carried that block from the start and neither stage ever had a
 * ThrottlingRateLimit, so the form that CloudFormation applies is pinned here.
 */
const yml = readFileSync(
  fileURLToPath(new URL("../serverless.yml", import.meta.url)),
  "utf8",
);

describe("http api throttle", () => {
  it("never uses the unsupported provider.httpApi form", () => {
    // As a key, not as the word in the comment that explains why.
    expect(yml).not.toMatch(/^\s*defaultRouteSettings:/m);
    expect(yml).not.toMatch(/^\s*throttling(Rate|Burst)Limit:/m);
  });

  it("patches the stage resource CloudFormation actually applies", () => {
    const ext = /extensions:\s*\n\s+HttpApiStage:\s*\n([\s\S]*?)\n\s{2}\w/.exec(
      yml,
    );
    expect(ext, "resources.extensions.HttpApiStage").not.toBeNull();
    const block = ext![1]!;
    expect(block).toMatch(/DefaultRouteSettings:/);
    expect(block).toMatch(/ThrottlingRateLimit: 20/);
    expect(block).toMatch(/ThrottlingBurstLimit: 40/);
    // Extensions replace DefaultRouteSettings wholesale, so `metrics: true`
    // stops reaching the stage unless it is restated inside the extension.
    expect(yml).toMatch(/metrics: true/);
    expect(block).toMatch(/DetailedMetricsEnabled: true/);
  });
});
