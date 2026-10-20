import { isIosUserAgent } from "./catalog";

/** The 잉여톤 app's applicationId; the intent URL launches this package only. */
export const ANDROID_PACKAGE = "life.yyt.console";

/**
 * The custom scheme the intent URL targets. An `https` target only reaches
 * the app once Android has verified its App Links (Android 12+ hands an
 * unverified https VIEW intent to the browser, even with the package
 * pinned), and a phone that installed the app before the console served
 * `assetlinks.json` never re-verifies — every tap then landed on the
 * "app missing" notice with the app installed. A custom scheme is routed by
 * the manifest filter alone; the pinned package keeps it hijack-free.
 */
export const ANDROID_SCHEME = "yytconsole";

/**
 * True on an Android browser, where "Open app" can hand the session to the
 * 잉여톤 app. `userAgentData.platform` is the honest signal where it exists;
 * the UA string is the fallback, minus iPads that spoof a desktop UA. An
 * in-app WebView (`; wv)` — a console link opened inside a chat app) cannot
 * follow an `intent://` navigation, so it gets no button rather than a
 * button that wastes a code.
 */
export function isAndroidBrowser(nav: Partial<Navigator> = navigator): boolean {
  const s = nav.userAgent ?? "";
  if (/; wv\)/.test(s)) return false;
  const ua = nav as { userAgentData?: { platform?: string } };
  const platform = ua.userAgentData?.platform;
  if (platform) return platform === "Android";
  return /\bAndroid\b/.test(s) && !isIosUserAgent(s);
}

/** Where a phone without the app lands: never carries the code. */
export function appMissingUrl(origin: string): string {
  return `${origin}/ui/installer?app=missing`;
}

/**
 * The Chrome intent URL "Open app" navigates to. A same-origin https link
 * would stay in the browser (Chrome never hands in-site navigation to an
 * App Link), so the intent form names the package outright: installed, the
 * app receives `yytconsole://<host>/app-open?code=…` (the console host stays
 * the authority so the app knows which server issued the code); missing,
 * Chrome loads the fallback URL instead. The code is a 120-second
 * single-use claim, never the token (`rules/security.md`).
 */
export function appOpenIntentUrl(origin: string, code: string): string {
  const { host } = new URL(origin);
  const fallback = encodeURIComponent(appMissingUrl(origin));
  return (
    `intent://${host}/app-open?code=${encodeURIComponent(code)}` +
    `#Intent;scheme=${ANDROID_SCHEME};package=${ANDROID_PACKAGE};` +
    `S.browser_fallback_url=${fallback};end`
  );
}

/**
 * True on an iPhone/iPad (desktop-mode iPads included), where "Open app" is
 * a Universal Link on the stage's link host (decisions, _Console app and
 * push on iOS_ #9). In-app browsers (a chat app's WebView) are not told
 * apart: they may ignore Universal Links, and a missed link only lands on
 * the Installer page with its code already burnt by the server.
 */
export function isIosSafariLike(nav: Partial<Navigator> = navigator): boolean {
  return isIosUserAgent(nav.userAgent ?? "", nav.maxTouchPoints ?? 0);
}

/**
 * The stage's link host, derived from the console host the SPA is served
 * from. The bundle is shared by both stages and carries no env, so the
 * console host is the only stage signal; any other host (a local dev
 * server, a preview) has none and the iOS button stays hidden.
 */
const LINK_HOSTS: Readonly<Record<string, string>> = {
  "console-dev.yyt.life": "link-dev.yyt.life",
  "console.yyt.life": "link.yyt.life",
};

export function linkHostFor(consoleHost: string): string | null {
  return LINK_HOSTS[consoleHost.toLowerCase()] ?? null;
}

/** Which handoff this browser can attempt, or `null` for no Open app. */
export function appOpenPlatform(
  nav: Partial<Navigator> = navigator,
  consoleHost: string = window.location.host,
): "android" | "ios" | null {
  if (isAndroidBrowser(nav)) return "android";
  if (isIosSafariLike(nav) && linkHostFor(consoleHost)) return "ios";
  return null;
}

/**
 * The Universal Link the iOS "Open app" anchor points at. A browser that
 * loads it instead of the app makes the server burn the code and redirect
 * to the Installer page, so a code that reached a browser is dead.
 */
export function appOpenLinkUrl(linkHost: string, code: string): string {
  return `https://${linkHost}/app-open?code=${encodeURIComponent(code)}`;
}
