/*
 * What every send path checks before a message leaves the platform, in one
 * place: the targeted send (state), a campaign and a broadcast (console) must
 * refuse the same payloads, or a template could carry what the send route
 * turns away.
 */

/**
 * FCM refuses a message whose data and notification exceed 4096 bytes. It is
 * measured as the UTF-8 length of the JSON of both ({@link pushPayloadBytes}),
 * which counts the quotes and braces too: stricter than FCM, never looser.
 */
export const PUSH_PAYLOAD_MAX_BYTES = 4096;
/** Keys one message's `data` may hold. */
export const PUSH_DATA_KEYS_MAX = 64;

// Data keys FCM reserves; a message carrying one is refused per recipient.
const RESERVED_DATA_KEY =
  /^(?:from|notification|message_type|google\..*|gcm\..*)$/;

/** Whether FCM reserves the data key (`from`, `google.*`, `gcm.*`, ...). */
export const isReservedPushDataKey = (key: string): boolean =>
  RESERVED_DATA_KEY.test(key);

export type PushDataFailure =
  /** Not a plain object. */
  | "not_object"
  /** More than {@link PUSH_DATA_KEYS_MAX} keys. */
  | "too_many_keys"
  /** A value that is not a string. */
  | "not_string"
  /** An empty key, or one FCM reserves. */
  | "reserved_key";

/** Why `data` cannot be sent, or `undefined` when it can. Never names a key. */
export function pushDataFailure(data: unknown): PushDataFailure | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data))
    return "not_object";
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length > PUSH_DATA_KEYS_MAX) return "too_many_keys";
  for (const [k, v] of entries) {
    if (typeof v !== "string") return "not_string";
    if (k === "" || isReservedPushDataKey(k)) return "reserved_key";
  }
  return undefined;
}

/** The size {@link PUSH_PAYLOAD_MAX_BYTES} bounds. */
export function pushPayloadBytes(m: {
  data?: Record<string, string>;
  notification?: { title: string; body: string };
}): number {
  return Buffer.byteLength(
    JSON.stringify({ data: m.data, notification: m.notification }),
  );
}

/** The fixed part of {@link pushChannelTopic}. */
export const PUSH_TOPIC_PREFIX = "yyt.push.";
const TOPIC_CHANNEL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The FCM topic of a push channel: what a broadcast is sent to and what the
 * client subscribes to after it registered its token (`docs/push.md`
 * *Broadcast*). Derived from the channel id alone, so neither side stores it.
 * Throws for an id that is not a channel id.
 */
export function pushChannelTopic(channelId: string): string {
  if (!TOPIC_CHANNEL_ID.test(channelId))
    throw new Error("invalid push channel id");
  return `${PUSH_TOPIC_PREFIX}${channelId}`;
}

/** The fixed part of {@link catalogAppTopic}. */
export const CATALOG_TOPIC_PREFIX = "yyt.catalog.";
const TOPIC_STAGE = /^[a-z0-9-]{1,32}$/;
const TOPIC_APP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The FCM topic of a catalog app on one stage: what a committed artifact is
 * announced on and what the console app subscribes to for an app installed on
 * the device (`docs/push.md` *Console app*). The server derives it and hands
 * it out in the app views; a client never builds it. The stage is part of the
 * name because one build of the console app talks to either stage. Throws
 * for a stage or an id no topic can be made of.
 */
export function catalogAppTopic(stage: string, appId: string): string {
  if (!TOPIC_STAGE.test(stage)) throw new Error("invalid stage");
  if (!TOPIC_APP_ID.test(appId)) throw new Error("invalid catalog app id");
  return `${CATALOG_TOPIC_PREFIX}${stage}.${appId}`;
}
