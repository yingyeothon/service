import { describe, expect, it } from "vitest";
import { SHARE_PAGE_SCRIPT, shareLang } from "../src/share-page.js";

/*
 * The bridge script (docs/decisions.md *Catalog share links* #5) under each
 * user agent it must tell apart, against a minimal DOM: which sections show,
 * where the escape button points and whether the page navigates by itself.
 */

const PAGE = "https://console.yyt.life/i/shr_0123456789abcdef0123456789abcdef";
const UA = {
  kakaoAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-S918N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 KAKAOTALK 10.8.0",
  kakaoIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.8.0",
  lineAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36 Line/14.6.0",
  slackWv:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0 Mobile Safari/537.36",
  chrome:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36",
  safari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iosApp:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Slack/24.05",
  desktop:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

function run(ua: string, loc: { search?: string; hash?: string } = {}) {
  const ids = [
    "escape",
    "escape-open",
    "escape-ios",
    "android",
    "noapp",
    "via-console",
    "ios",
    "desktop",
    "copy",
    "link",
  ];
  const el: Record<
    string,
    {
      hidden: boolean;
      href: string;
      textContent: string;
      addEventListener: () => void;
      select: () => void;
    }
  > = {};
  for (const id of ids)
    el[id] = {
      hidden: id !== "desktop" && id !== "copy" && id !== "via-console",
      href: "#",
      textContent: "",
      addEventListener: () => {},
      select: () => {},
    };
  el.d = {
    textContent: JSON.stringify({ pageUrl: PAGE, copied: "ok" }),
  } as never;
  const nav: string[] = [];
  const location = {
    search: loc.search ?? "",
    hash: loc.hash ?? "",
    set href(v: string) {
      nav.push(v);
    },
    replace: (v: string) => nav.push(v),
  };
  const store = new Map<string, string>();
  // The page runs the script as an inline element; this is that, minus a DOM.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  new Function(
    "document",
    "navigator",
    "location",
    "sessionStorage",
    SHARE_PAGE_SCRIPT,
  )(
    { getElementById: (i: string) => el[i] },
    { userAgent: ua, maxTouchPoints: ua.includes("iPhone") ? 5 : 0 },
    location,
    {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    },
  );
  const shown = ids.filter((i) => !el[i]!.hidden);
  return { el, nav, shown };
}

describe("share bridge script", () => {
  it("KakaoTalk opens the default browser once, on Android and iOS", () => {
    for (const ua of [UA.kakaoAndroid, UA.kakaoIos]) {
      const r = run(ua);
      const target = `kakaotalk://web/openExternal?url=${encodeURIComponent(PAGE)}`;
      expect(r.el["escape-open"]!.href).toBe(target);
      expect(r.nav).toEqual([target]);
      expect(r.shown).toContain("escape");
    }
  });

  it("LINE reloads with openExternalBrowser=1, but never twice", () => {
    const r = run(UA.lineAndroid);
    expect(r.nav).toEqual([`${PAGE}?openExternalBrowser=1`]);
    expect(
      run(UA.lineAndroid, { search: "?openExternalBrowser=1" }).nav,
    ).toEqual([]);
  });

  it("another Android WebView gets a Chrome intent button, no automatic navigation", () => {
    const r = run(UA.slackWv);
    expect(r.el["escape-open"]!.href).toBe(
      "intent://console.yyt.life/i/shr_0123456789abcdef0123456789abcdef#Intent;scheme=https;package=com.android.chrome;end",
    );
    expect(r.nav).toEqual([]);
    expect(r.shown).toEqual(expect.arrayContaining(["escape", "android"]));
  });

  it("Android Chrome shows the install section and the console-app intent with a fallback", () => {
    const r = run(UA.chrome);
    expect(r.shown).toEqual(["android", "via-console", "copy"]);
    expect(r.el["via-console"]!.href).toBe(
      `intent://console.yyt.life/i/shr_0123456789abcdef0123456789abcdef#Intent;scheme=yytconsole;package=life.yyt.console;S.browser_fallback_url=${encodeURIComponent(`${PAGE}?noapp=1`)};end`,
    );
    expect(run(UA.chrome, { search: "?noapp=1" }).shown).toContain("noapp");
  });

  it("iOS Safari shows the iOS section; another iOS app is told to open Safari", () => {
    expect(run(UA.safari).shown).toEqual(["via-console", "ios", "copy"]);
    const r = run(UA.iosApp);
    expect(r.shown).toEqual(
      expect.arrayContaining(["escape", "escape-ios", "ios"]),
    );
    expect(r.nav).toEqual([]);
  });

  it("a desktop keeps the QR section only", () => {
    expect(run(UA.desktop).shown).toEqual(["via-console", "desktop", "copy"]);
  });

  it("picks English only when the first Accept-Language tag is English", () => {
    expect(shareLang("en-US,en;q=0.9,ko;q=0.8")).toBe("en");
    expect(shareLang("ko-KR,ko;q=0.9,en;q=0.8")).toBe("ko");
    expect(shareLang(undefined)).toBe("ko");
  });
});
