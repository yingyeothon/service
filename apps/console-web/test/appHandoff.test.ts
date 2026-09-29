import { describe, expect, it } from "vitest";
import {
  appMissingUrl,
  appOpenIntentUrl,
  isAndroidBrowser,
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
        "#Intent;scheme=https;package=life.yyt.console;" +
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
