import { describe, expect, it } from "vitest";
import {
  appMissingUrl,
  appOpenIntentUrl,
  appOpenLinkUrl,
  appOpenPlatform,
  isAndroidBrowser,
  isIosSafariLike,
  linkHostFor,
} from "../src/lib/appHandoff";

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";

describe("isAndroidBrowser", () => {
  it("prefers userAgentData.platform and falls back to the UA string", () => {
    expect(
      isAndroidBrowser({
        userAgentData: { platform: "Android" },
        userAgent: DESKTOP_UA,
      } as Partial<Navigator>),
    ).toBe(true);
    expect(
      isAndroidBrowser({
        userAgentData: { platform: "Windows" },
        userAgent: ANDROID_UA,
      } as Partial<Navigator>),
    ).toBe(false);
    expect(isAndroidBrowser({ userAgent: ANDROID_UA })).toBe(true);
    // An in-app WebView cannot follow intent:// — no button.
    expect(
      isAndroidBrowser({
        userAgent:
          "Mozilla/5.0 (Linux; Android 14; SM-S911N Build/UP1A; wv) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36",
      }),
    ).toBe(false);
    expect(isAndroidBrowser({ userAgent: IOS_UA })).toBe(false);
    expect(isAndroidBrowser({ userAgent: DESKTOP_UA })).toBe(false);
    expect(isAndroidBrowser({})).toBe(false);
  });
});

describe("appOpenIntentUrl", () => {
  const origin = "https://console-dev.yyt.life";
  const code = "hoff_" + "ab".repeat(16);

  it("pins the package and carries the code only in the intent target", () => {
    const url = appOpenIntentUrl(origin, code);
    expect(url).toBe(
      `intent://console-dev.yyt.life/app-open?code=${code}` +
        "#Intent;scheme=yytconsole;package=life.yyt.console;" +
        "S.browser_fallback_url=https%3A%2F%2Fconsole-dev.yyt.life%2Fui%2Finstaller%3Fapp%3Dmissing;end",
    );
    const fallback = decodeURIComponent(
      /S\.browser_fallback_url=([^;]+);/.exec(url)![1]!,
    );
    expect(fallback).toBe(appMissingUrl(origin));
    expect(fallback).not.toContain("hoff_");
  });

  it("keeps a port and drops any path of the origin", () => {
    expect(appOpenIntentUrl("http://localhost:5173", code)).toMatch(
      /^intent:\/\/localhost:5173\/app-open\?code=hoff_/,
    );
  });
});

const IPAD_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15";
const KAKAO_IOS_UA = `${IOS_UA} KAKAOTALK 10.9.0`;

describe("isIosSafariLike", () => {
  it("matches iPhones, desktop-mode iPads and in-app browsers on iOS", () => {
    expect(isIosSafariLike({ userAgent: IOS_UA })).toBe(true);
    expect(isIosSafariLike({ userAgent: KAKAO_IOS_UA })).toBe(true);
    expect(
      isIosSafariLike({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 }),
    ).toBe(true);
    // A real Mac has no touch points.
    expect(
      isIosSafariLike({ userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0 }),
    ).toBe(false);
    expect(isIosSafariLike({ userAgent: ANDROID_UA })).toBe(false);
    expect(isIosSafariLike({})).toBe(false);
  });
});

describe("linkHostFor", () => {
  it.each([
    ["console-dev.yyt.life", "link-dev.yyt.life"],
    ["console.yyt.life", "link.yyt.life"],
    ["CONSOLE.yyt.life", "link.yyt.life"],
    ["localhost:5173", null],
    ["console.yyt.life:8443", null],
    ["console-prod.yyt.life", null],
    ["evil-console.yyt.life", null],
    ["console.yyt.life.example.com", null],
    ["link.yyt.life", null],
    ["", null],
  ])("%s -> %s", (host, want) => {
    expect(linkHostFor(host)).toBe(want);
  });
});

describe("appOpenPlatform", () => {
  it("is Android || (iOS && a derived link host)", () => {
    const dev = "console-dev.yyt.life";
    expect(appOpenPlatform({ userAgent: ANDROID_UA }, dev)).toBe("android");
    // Android does not need a link host.
    expect(appOpenPlatform({ userAgent: ANDROID_UA }, "localhost:5173")).toBe(
      "android",
    );
    expect(appOpenPlatform({ userAgent: IOS_UA }, dev)).toBe("ios");
    expect(appOpenPlatform({ userAgent: IOS_UA }, "console.yyt.life")).toBe(
      "ios",
    );
    expect(appOpenPlatform({ userAgent: IOS_UA }, "localhost:5173")).toBeNull();
    expect(appOpenPlatform({ userAgent: DESKTOP_UA }, dev)).toBeNull();
  });
});

describe("appOpenLinkUrl", () => {
  it("is an https link-host URL carrying the code", () => {
    const code = "hoff_" + "ab".repeat(16);
    expect(appOpenLinkUrl("link-dev.yyt.life", code)).toBe(
      `https://link-dev.yyt.life/app-open?code=${code}`,
    );
  });
});
