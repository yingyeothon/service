import { GetParametersByPathCommand } from "@aws-sdk/client-ssm";
import { describe, expect, it } from "vitest";
import { ssmSlotLoader, SSM_MAX_PAGES } from "../src/index.js";

type Client = Parameters<typeof ssmSlotLoader>[0]["client"];

/** An SSM client answering `GetParametersByPath` from canned pages. */
function fakeSsm(pages: Array<Record<string, unknown>>) {
  const inputs: unknown[] = [];
  const client = {
    send: async (command: unknown) => {
      expect(command).toBeInstanceOf(GetParametersByPathCommand);
      inputs.push((command as GetParametersByPathCommand).input);
      return pages[Math.min(inputs.length - 1, pages.length - 1)];
    },
  } as unknown as Client;
  return { client, inputs };
}

const PATH = "/yyt-service/dev/push/fcm/";

describe("ssmSlotLoader", () => {
  it("reads every page with decryption and names slots by the last segment", async () => {
    const { client, inputs } = fakeSsm([
      {
        Parameters: [
          { Name: `${PATH}p1`, Value: "json-1" },
          { Name: `${PATH}p2`, Value: "json-2" },
        ],
        NextToken: "page-2",
      },
      {
        Parameters: [
          { Name: `${PATH}p10`, Value: "json-10" },
          { Name: `${PATH}empty` },
          { Name: "/elsewhere/p9", Value: "x" },
          { Value: "nameless" },
        ],
      },
    ]);
    // A path without the trailing slash is the same path.
    const load = ssmSlotLoader({ path: PATH.slice(0, -1), client });
    expect(await load()).toEqual([
      { slot: "p1", serviceAccountJson: "json-1" },
      { slot: "p2", serviceAccountJson: "json-2" },
      { slot: "p10", serviceAccountJson: "json-10" },
    ]);
    expect(inputs).toEqual([
      {
        Path: PATH,
        Recursive: false,
        WithDecryption: true,
        MaxResults: 10,
        NextToken: undefined,
      },
      {
        Path: PATH,
        Recursive: false,
        WithDecryption: true,
        MaxResults: 10,
        NextToken: "page-2",
      },
    ]);
  });

  it("is empty for a path without parameters", async () => {
    const { client } = fakeSsm([{}]);
    expect(await ssmSlotLoader({ path: PATH, client })()).toEqual([]);
  });

  it("stops at the page cap", async () => {
    const { client, inputs } = fakeSsm([
      { Parameters: [{ Name: `${PATH}p1`, Value: "v" }], NextToken: "more" },
    ]);
    const slots = await ssmSlotLoader({ path: PATH, client })();
    expect(inputs).toHaveLength(SSM_MAX_PAGES);
    expect(slots).toHaveLength(SSM_MAX_PAGES);
  });

  it("lets an SDK error through", async () => {
    const client = {
      send: async () => {
        throw new Error("AccessDenied");
      },
    } as unknown as Client;
    await expect(ssmSlotLoader({ path: PATH, client })()).rejects.toThrow(
      "AccessDenied",
    );
  });
});
