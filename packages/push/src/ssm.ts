import type {
  GetParametersByPathCommandOutput,
  SSMClient,
} from "@aws-sdk/client-ssm";
import type { SlotLoader, SlotSource } from "./pool.js";

/** Pages read at most (10 parameters each): far above any real pool. */
export const SSM_MAX_PAGES = 20;

export interface SsmSlotLoaderOptions {
  /** `/yyt-service/{stage}/push/fcm/`; a missing trailing slash is added. */
  path: string;
  /** Built once per container by `handler.ts` (`new SSMClient({})`). */
  client: Pick<SSMClient, "send">;
}

/**
 * The pool as stored: every SecureString directly under `path`, the last name
 * segment being the slot label. Needs `ssm:GetParametersByPath` on the path
 * and `kms:Decrypt` on its key. SDK errors propagate; `createPushPool` turns
 * them into `unavailable` (or keeps serving the previous list).
 *
 * The SDK module is imported on the first load, not with this file: a stack
 * whose other routes never touch push must not pay for it at cold start.
 */
export function ssmSlotLoader(options: SsmSlotLoaderOptions): SlotLoader {
  const path = options.path.endsWith("/") ? options.path : `${options.path}/`;
  return async () => {
    const { GetParametersByPathCommand } = await import("@aws-sdk/client-ssm");
    const out: SlotSource[] = [];
    let token: string | undefined;
    for (let page = 0; page < SSM_MAX_PAGES; page++) {
      const res: GetParametersByPathCommandOutput = await options.client.send(
        new GetParametersByPathCommand({
          Path: path,
          Recursive: false,
          WithDecryption: true,
          MaxResults: 10,
          NextToken: token,
        }),
      );
      for (const p of res.Parameters ?? []) {
        if (!p.Name?.startsWith(path) || typeof p.Value !== "string") continue;
        out.push({
          slot: p.Name.slice(path.length),
          serviceAccountJson: p.Value,
        });
      }
      token = res.NextToken;
      if (!token) break;
    }
    return out;
  };
}
