import { AppError } from "@yyt/core";
import {
  PUSH_TEMPLATE_BODY_MAX,
  PUSH_TEMPLATE_TITLE_MAX,
  type PushMessageText,
} from "@yyt/console-db";
import {
  pushDataFailure,
  pushPayloadBytes,
  PUSH_DATA_KEYS_MAX,
  PUSH_PAYLOAD_MAX_BYTES,
} from "@yyt/push";

/*
 * The template grammar of push campaigns (docs/decisions.md *Push
 * notifications* #9, `docs/push.md` *Templates*).
 *
 * A placeholder is `{{name}}` with `name` = `[A-Za-z_][A-Za-z0-9_]{0,31}`,
 * written without blanks. It may stand in `title`, `body` and the **values**
 * of `data`; a data key is always literal. Nothing else is syntax: `{{ a }}`,
 * `{{a.b}}`, `{{}}`, a lone `{{` and a name of 33 characters are sent as
 * written. Placeholders do not nest and a substituted value is never read
 * again, so a value holding `{{x}}` stays that text.
 */

/** A variable name; also a CSV column name. */
export const PUSH_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]{0,31})\}\}/g;
// C0 controls and DEL; `\n` and `\t` are allowed in a body and a data value.
// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
const CONTROL = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- rejecting control chars is the point
const CONTROL_BUT_NL_TAB = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export type PushMessage = {
  data?: Record<string, string>;
  notification?: { title: string; body: string };
};

const bad = (message: string, reason?: string): AppError =>
  new AppError(
    "bad_request",
    message,
    reason ? { details: { reason } } : undefined,
  );

/** Every string of the message a placeholder may stand in. */
const texts = (t: PushMessageText): string[] => [
  t.title,
  t.body,
  ...Object.values(t.data),
];

/** The variables a message names, sorted, each once. */
export function templateVars(t: PushMessageText): string[] {
  const names = new Set<string>();
  for (const s of texts(t))
    for (const m of s.matchAll(PLACEHOLDER)) names.add(m[1]!);
  return [...names].sort();
}

/** `s` with every placeholder replaced by `value(name)`, in one pass. */
const fill = (s: string, value: (name: string) => string): string =>
  s.replace(PLACEHOLDER, (_all, name: string) => value(name));

/** The message FCM is handed: no notification without a title, no empty data. */
function toMessage(t: PushMessageText): PushMessage {
  return {
    ...(Object.keys(t.data).length > 0 ? { data: t.data } : {}),
    ...(t.title !== ""
      ? { notification: { title: t.title, body: t.body } }
      : {}),
  };
}

/**
 * Checks a template (or an inline broadcast message) and returns it in
 * stored shape. Refused: a title over {@link PUSH_TEMPLATE_TITLE_MAX} or a
 * body over {@link PUSH_TEMPLATE_BODY_MAX} characters, a control character,
 * a body without a title, `data` the send route would refuse (a non-string
 * value, an empty or FCM-reserved key, more than 64 keys), a message with
 * neither a title nor data, and a message whose literal text alone exceeds
 * the payload limit (`push_payload_too_large`) -- every placeholder counted
 * as one byte, the least a variable can add. What the variables add is
 * checked per row at send time.
 */
export function checkMessageText(raw: {
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
}): PushMessageText {
  const title = raw.title ?? "";
  const body = raw.body ?? "";
  if (title.length > PUSH_TEMPLATE_TITLE_MAX)
    throw bad(`title holds at most ${PUSH_TEMPLATE_TITLE_MAX} characters`);
  if (body.length > PUSH_TEMPLATE_BODY_MAX)
    throw bad(`body holds at most ${PUSH_TEMPLATE_BODY_MAX} characters`);
  if (CONTROL.test(title)) throw bad("title holds a control character");
  if (CONTROL_BUT_NL_TAB.test(body))
    throw bad("body holds a control character");
  if (title === "" && body !== "") throw bad("a body needs a title");
  const data = raw.data ?? {};
  const failure = pushDataFailure(data);
  if (failure === "too_many_keys")
    throw bad(`data holds at most ${PUSH_DATA_KEYS_MAX} keys`);
  if (failure === "reserved_key") throw bad("data holds a key FCM reserves");
  if (failure !== undefined) throw bad("data must be an object of strings");
  for (const [k, v] of Object.entries(data as Record<string, string>))
    if (CONTROL.test(k) || CONTROL_BUT_NL_TAB.test(v))
      throw bad("data holds a control character");
  const text: PushMessageText = {
    title,
    body,
    data: data as Record<string, string>,
  };
  if (title === "" && Object.keys(text.data).length === 0)
    throw bad("a title or data is required");
  const least = pushPayloadBytes(toMessage(renderWith(text, () => "x")));
  if (least > PUSH_PAYLOAD_MAX_BYTES)
    throw bad(
      `the message exceeds ${PUSH_PAYLOAD_MAX_BYTES} bytes`,
      "push_payload_too_large",
    );
  return text;
}

function renderWith(
  t: PushMessageText,
  value: (name: string) => string,
): PushMessageText {
  return {
    title: fill(t.title, value),
    body: fill(t.body, value),
    data: Object.fromEntries(
      Object.entries(t.data).map(([k, v]) => [k, fill(v, value)]),
    ),
  };
}

export type RenderResult =
  | { ok: true; message: PushMessage }
  /** A variable the message names is empty or absent in this row. */
  | { ok: false; reason: "missing-variable" }
  /** The rendered message exceeds the payload limit. */
  | { ok: false; reason: "too-large" }
  /** A value put a control character where a template may hold none. */
  | { ok: false; reason: "invalid-value" };

/**
 * A renderer for one message: the variables are found once, then each row
 * is one pass per string. `value(name)` is the row's value of a variable;
 * `undefined` and `""` are both "missing".
 */
export function createRenderer(
  t: PushMessageText,
): (value: (name: string) => string | undefined) => RenderResult {
  const vars = templateVars(t);
  const fixed = vars.length === 0 ? toMessage(t) : undefined;
  return (value) => {
    if (fixed) return { ok: true, message: fixed };
    for (const name of vars)
      if ((value(name) ?? "") === "")
        return { ok: false, reason: "missing-variable" };
    const text = renderWith(t, (name) => value(name) ?? "");
    // The rule a template is held to (`checkMessageText`), for what the
    // row's values made of it: a CSV field may hold any byte.
    if (
      CONTROL.test(text.title) ||
      CONTROL_BUT_NL_TAB.test(text.body) ||
      Object.values(text.data).some((v) => CONTROL_BUT_NL_TAB.test(v))
    )
      return { ok: false, reason: "invalid-value" };
    const message = toMessage(text);
    if (pushPayloadBytes(message) > PUSH_PAYLOAD_MAX_BYTES)
      return { ok: false, reason: "too-large" };
    return { ok: true, message };
  };
}

/** The message of a broadcast: literal text, so it may name no variable. */
export function literalMessage(t: PushMessageText): PushMessage {
  if (templateVars(t).length > 0)
    throw bad(
      "a broadcast message cannot hold {{variables}}: there is no row to fill them from",
      "template_has_variables",
    );
  return toMessage(t);
}
