import { errorMessage } from "./format";

/*
 * Push channels (docs/decisions.md *Push notifications (Android, FCM)*): the
 * client half of the server's grammar, and its refusals as sentences. The
 * service-account key is write-only: nothing here echoes, stores or logs it.
 */

/** The server's `PUSH_PACKAGE_NAME`: two or more dot-separated segments. */
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
export const PACKAGE_NAME_MAX = 255;
/** The server's `SERVICE_ACCOUNT_MAX_CHARS`. */
export const SERVICE_ACCOUNT_MAX = 16_384;

export const PACKAGE_NAME_HINT =
  "An Android application id: two or more dot-separated segments of letters, digits and _, each starting with a letter (com.example.game).";

/** Why `name` is not a package name the server takes, or `null`. */
export function packageNameProblem(name: string): string | null {
  if (name === "") return "The package name is required.";
  if (name.length > PACKAGE_NAME_MAX)
    return `At most ${PACKAGE_NAME_MAX} characters.`;
  return PACKAGE_NAME.test(name) ? null : PACKAGE_NAME_HINT;
}

/** Why the pasted key cannot be sent, or `null`. Its content is the server's to judge. */
export function serviceAccountProblem(key: string): string | null {
  if (key.trim() === "") return "The service-account key is required.";
  if (key.length > SERVICE_ACCOUNT_MAX)
    return "The key is larger than a service-account key file (16 KiB).";
  return null;
}

/** `details.field` of a `service_account` refusal: the part of the key that failed. */
const SERVICE_ACCOUNT_FIELDS: Record<string, string> = {
  too_large: "it is larger than a service-account key file (16 KiB)",
  not_json: "it is not JSON; paste the whole key file",
  not_object: "it is not a JSON object; paste the whole key file",
  project_id: "its project_id is missing or malformed",
  client_email: "its client_email is missing or malformed",
  token_uri: "its token_uri is not Google's token endpoint",
  private_key_id: "its private_key_id is missing or malformed",
  private_key: "its private_key is missing or not a usable RSA key",
};

/** Where a push refusal is shown: under a field, as the cap, or as a notice. */
export type PushProblem =
  | { at: "packageName" | "serviceAccount"; message: string }
  /** `push.appsPerTeam` reached: the team's Limits section takes the request. */
  | { at: "limit"; message: string; value: number | null }
  /** A condition of the platform, not of what was typed. */
  | { at: "platform"; message: string }
  | { at: "form"; message: string };

interface ErrorShape {
  status?: number;
  code?: unknown;
  details?: unknown;
}

/**
 * What was asked when the refusal came. `not_registered` is one reason with
 * two meanings: a download that has no file to give, and an edit of a channel
 * whose registration is still under way.
 */
export type PushAction = "create" | "download" | "update" | "senderKey";

/**
 * A push create, edit, sender-key or download refusal as the sentence to show
 * and the place to show it. Read off the error object rather than `instanceof
 * ApiError`: the tests' mock carries no class.
 */
export function pushProblem(
  e: unknown,
  action: PushAction = "download",
): PushProblem {
  const { details, status, code } = e as ErrorShape;
  // The per-member write slot (two writes a second). A create, a sender-key
  // write and every google-services.json download take it.
  if (status === 429 || code === "rate_limited")
    return {
      at: "platform",
      message:
        action === "download"
          ? "Too many requests in a row: each download is a call to Firebase and counts as a write. Nothing is wrong with the channel; try again in a second."
          : "Too many writes in a row. Nothing was changed; try again in a second.",
    };
  const d = (
    details && typeof details === "object" && !Array.isArray(details)
      ? details
      : {}
  ) as { reason?: unknown; field?: unknown; limit?: unknown; value?: unknown };
  if (d.limit === "push.appsPerTeam") {
    const value = typeof d.value === "number" ? d.value : null;
    return {
      at: "limit",
      value,
      message:
        value === null
          ? "This team has reached its limit of push apps on the platform sender."
          : `This team already has ${value} push app${value === 1 ? "" : "s"} on the platform sender, which is its limit.`,
    };
  }
  switch (d.reason) {
    case "package_taken":
      return {
        at: "packageName",
        message:
          "This package name is already registered on this stage. A package has one platform-sender push channel; delete the other channel first, use this build's own applicationId, or send through your own Firebase project (sender: team).",
      };
    case "package_refused":
      return {
        at: "packageName",
        message:
          "Firebase refused this package name. Use the exact applicationId of the Android build.",
      };
    case "service_account": {
      const field = typeof d.field === "string" ? d.field : "";
      return {
        at: "serviceAccount",
        message: `The service-account key was refused: ${
          SERVICE_ACCOUNT_FIELDS[field] ?? "it is not a usable key file"
        }.`,
      };
    }
    case "push_not_configured":
      return {
        at: "platform",
        message:
          "Push is not set up on this stage: the platform has no Firebase project provisioned here. Nothing in the form is wrong; a platform admin has to provision one.",
      };
    case "push_pool_full":
      return {
        at: "platform",
        message:
          "Every Firebase project of the platform is full or closed, so no registration slot is free. Nothing in the form is wrong; a platform admin has to add or open one.",
      };
    case "firebase_unavailable":
      return {
        at: "platform",
        message:
          "Firebase did not answer the platform, or refused its call. Nothing in the form is wrong and nothing was changed; try again in a minute.",
      };
    case "not_registered":
      return action === "update"
        ? {
            at: "platform",
            message:
              "This channel's registration with Firebase is not finished, so its settings cannot be changed yet (the name still can). Try again in a minute; if it still shows as not registered tomorrow, delete the channel and create it again.",
          }
        : {
            at: "form",
            message:
              "This channel has no platform registration, so there is no google-services.json to download.",
          };
    case "registration_missing":
      return {
        at: "platform",
        message:
          "The channel's registration is missing in Firebase. This is a platform-side condition; a platform admin has to look at it.",
      };
    default:
      return { at: "form", message: errorMessage(e) };
  }
}

/** Hands a fetched file to the browser's download flow. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoked on a later task: the click only queued the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** What deleting a channel of `kind` takes with it (confirm modals, the danger zone). */
export const channelDeleteNote = (kind: string): string =>
  kind === "push"
    ? "Its Firebase registration and every device token registered on it are deleted with it, and its API key stops working."
    : "Sockets on it are closed and its credentials stop working.";
