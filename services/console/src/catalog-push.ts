import type { Logger } from "@yyt/core";
import type {
  CatalogAppRow,
  CatalogArtifactRow,
  ListingsDb,
} from "@yyt/console-db";
import {
  catalogAppTopic,
  isPushNotConfigured,
  pushPayloadBytes,
  PUSH_PAYLOAD_MAX_BYTES,
  type PushMessage,
  type PushPool,
} from "@yyt/push";

/*
 * The console app's update notice (docs/decisions.md *Push notifications* #10,
 * docs/push.md *Console app*): one FCM topic message per committed Android
 * artifact, sent through the first slot of the stage's pool -- the project the
 * console app is registered in. No device list, no fan-out, no table.
 *
 * A topic is not private: whoever holds the console app's public Firebase
 * config can subscribe to any name. So the message says no more than a public
 * listing shows, and for an app without one it leaves the name out.
 */

/** How long a commit may wait for the notice, pool load and send together. */
export const CATALOG_PUSH_BUDGET_MS = 3_000;
/** An update notice is worthless once it is a day old. */
export const CATALOG_PUSH_TTL_SEC = 86_400;
/** Platforms the console app can install; nothing else is announced. */
const NOTIFIED_PLATFORMS: ReadonlySet<string> = new Set(["android"]);
const VERSION_MAX_CHARS = 64;
/** The title of a notice that may not name its app (the app's UI language). */
export const CATALOG_PUSH_GENERIC_TITLE = "앱 업데이트";

/**
 * The topic of a catalog app, for the app and listing views; `undefined` for
 * a stage or an id no topic can be made of (none the console mints).
 */
export function catalogTopicOf(
  stage: string,
  appId: string,
): string | undefined {
  try {
    return catalogAppTopic(stage, appId);
  } catch {
    return undefined;
  }
}

/**
 * The notice of one artifact, or `undefined` when none is sent (a platform
 * the console app cannot install, or an id without a topic). `named` says
 * whether the app's name is public already.
 */
export function buildCatalogPush({
  stage,
  app,
  artifact,
  named,
}: {
  stage: string;
  app: Pick<CatalogAppRow, "id" | "name">;
  artifact: Pick<CatalogArtifactRow, "platform" | "tags">;
  named: boolean;
}): PushMessage | undefined {
  if (!NOTIFIED_PLATFORMS.has(artifact.platform)) return undefined;
  const topic = catalogTopicOf(stage, app.id);
  if (!topic) return undefined;
  const version = (artifact.tags.version ?? "").slice(0, VERSION_MAX_CHARS);
  const message: PushMessage = {
    target: { topic },
    priority: "high",
    ttlSec: CATALOG_PUSH_TTL_SEC,
    // One release is often several Android artifacts (or two commits racing):
    // a device that was offline gets the newest notice of the app, not each.
    collapseKey: app.id,
    notification: {
      title: named ? app.name : CATALOG_PUSH_GENERIC_TITLE,
      body: version ? `새 버전 ${version}` : "새 빌드가 올라왔습니다",
    },
    data: {
      kind: "catalog",
      appId: app.id,
      version,
      platform: artifact.platform,
    },
  };
  return pushPayloadBytes(message) <= PUSH_PAYLOAD_MAX_BYTES
    ? message
    : undefined;
}

/**
 * Whether the app's name is already readable by anyone: it has a `public`
 * listing no takedown hides. A lookup that fails counts as "no".
 */
async function isPubliclyListed(
  listings: Pick<ListingsDb, "findListing">,
  appId: string,
): Promise<boolean> {
  try {
    const l = await listings.findListing(appId);
    return l !== undefined && l.audience === "public" && l.takedown === null;
  } catch {
    return false;
  }
}

/** Slot labels in the pool's natural order (`p2` before `p10`). */
const labelBefore = (a: string, b: string): boolean =>
  a.localeCompare(b, "en", { numeric: true }) < 0;

/**
 * Best-effort notice for a committed artifact. Never throws and never takes
 * longer than `budgetMs`: the upload already succeeded, so an unprovisioned
 * pool, a missing slot, an FCM refusal or a slow answer only logs -- by slot
 * label and result code, never a project id.
 *
 * The console app listens in one project only, the first slot's. When the
 * pool left out a slot that sorts before the one used (a broken or removed
 * key), the send still succeeds through the next project and reaches nobody:
 * that is one `slot_skipped` warning per commit, by label.
 */
export async function notifyCatalogTopic({
  pool,
  stage,
  app,
  artifact,
  listings,
  logger,
  budgetMs = CATALOG_PUSH_BUDGET_MS,
}: {
  pool: PushPool | undefined;
  stage: string;
  app: Pick<CatalogAppRow, "id" | "name">;
  artifact: Pick<CatalogArtifactRow, "platform" | "tags">;
  listings: Pick<ListingsDb, "findListing">;
  logger: Logger;
  budgetMs?: number;
}): Promise<void> {
  if (!pool || !NOTIFIED_PLATFORMS.has(artifact.platform)) return;
  let slot: string | undefined;
  const send = async (): Promise<string | undefined> => {
    // Natural label order: the first slot is the project the console app
    // was registered in.
    slot = (await pool.slots())[0]?.slot;
    if (slot === undefined) return undefined; // push is not set up here
    const held = await pool.bySlot(slot);
    if (!held) return "slot_missing";
    const used = slot;
    for (const s of await pool.skipped())
      if (labelBefore(s.slot, used))
        logger.warn("catalog push slot skipped", {
          slot: s.slot,
          used,
          code: "slot_skipped",
        });
    const message = buildCatalogPush({
      stage,
      app,
      artifact,
      named: await isPubliclyListed(listings, app.id),
    });
    if (!message) return "unsendable";
    const r = await held.fcm.send(message);
    if (r.kind === "sent") return undefined;
    return "reason" in r ? `${r.kind}:${r.reason}` : r.kind;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([
      send(),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("budget"), budgetMs);
      }),
    ]);
    if (code !== undefined) logger.warn("catalog push failed", { slot, code });
  } catch (e) {
    if (!isPushNotConfigured(e))
      logger.warn("catalog push failed", { slot, code: "error" });
  } finally {
    clearTimeout(timer);
  }
}
