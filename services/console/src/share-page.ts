import { createHash } from "node:crypto";
import type { ShareBuildKind } from "@yyt/console-db";
import type { HttpResult } from "@yyt/http";

/*
 * The install bridge (docs/decisions.md *Catalog share links and install
 * bridge* #5): one server-rendered page per share link, so a messenger's
 * preview reads per-link Open Graph tags and a tap inside an in-app browser
 * can be steered out to a browser that is allowed to install. Rendering is
 * pure; `share-links.ts` resolves what the link grants.
 *
 * The page carries no inline handler and no `style` attribute: one script
 * and one style element, both pinned by hash in the page's own CSP (the
 * console distribution's API behavior adds none).
 */

export type ShareLang = "ko" | "en";

export interface SharePageBuild {
  version: string | null;
  /** The CDN URL (Android) or the `itms-services://` URL (iOS). */
  url: string;
}

export interface SharePageModel {
  title: string;
  /** The link's own summary, else a public listing's; `null` otherwise. */
  summary: string | null;
  /** The one build kind a link grants (decision #10), shown beside the title. */
  buildKind?: ShareBuildKind | null;
  /** The app's preview image on the artifact CDN (decision #11). */
  image?: { url: string; width: number; height: number } | null;
  teamName: string | null;
  /** Epoch seconds; `null` for a public link. */
  expiresAt: number | null;
  /** The canonical URL of this page, `https://console…/i/{ref}`. */
  pageUrl: string;
  /** The newest Android artifact when it is an `.apk`. */
  android: SharePageBuild | null;
  /** The newest iOS ad-hoc build's install URL. */
  ios: SharePageBuild | null;
  /** The SPA's installer page (the console app itself, for members). */
  installerUrl: string;
  /** The page as a QR code (inline SVG), for a desktop visitor. */
  qrSvg: string;
}

const T = {
  ko: {
    unavailableTitle: "링크를 사용할 수 없습니다",
    unavailableBody:
      "만료되었거나 폐기된 링크이거나, 공개되지 않은 앱입니다. 링크를 보낸 사람에게 새 링크를 요청하세요.",
    install: "설치하기",
    by: "팀",
    expires: "링크 만료",
    escapeLead:
      "메신저 안의 브라우저에서는 설치가 막힐 수 있습니다. 기본 브라우저로 열어 주세요.",
    escapeOpen: "외부 브라우저로 열기",
    escapeIos:
      "Safari에서 열어 주세요: 화면의 공유(또는 ⋯) 메뉴에서 “Safari로 열기”를 누르거나, 링크를 복사해 Safari에 붙여 넣으세요.",
    copy: "링크 복사",
    copied: "복사했습니다",
    apk: "APK 다운로드",
    viaConsole: "잉여톤 콘솔 앱으로 설치",
    viaConsoleHint:
      "콘솔 앱이 설치되어 있으면 앱이 다운로드와 설치를 처리합니다.",
    noConsoleApp:
      "콘솔 앱이 설치되어 있지 않습니다. APK를 직접 받아 설치하세요.",
    stepsTitle: "설치가 안 될 때",
    steps: [
      "다운로드가 끝나면 알림이나 다운로드 목록에서 파일을 엽니다.",
      "“출처를 알 수 없는 앱” 안내가 나오면 설정에서 지금 쓰는 브라우저(Chrome 등)의 “이 출처 허용”을 켜고 돌아옵니다.",
      "Play 프로텍트 경고가 나오면 “세부정보”를 펼쳐 “무시하고 설치”를 누릅니다.",
      "업데이트가 설치되지 않으면(서명이 다른 빌드) 기존 앱을 지운 뒤 다시 설치합니다.",
    ],
    installer: "콘솔 앱 받기(멤버 전용)",
    ios: "iPhone/iPad에 설치",
    iosHint:
      "Ad-hoc 빌드라 등록된 기기에서만 설치됩니다. Safari에서 열어야 합니다.",
    desktop:
      "휴대폰 카메라로 QR 코드를 찍어 휴대폰에서 여세요. 파일을 직접 받을 수도 있습니다.",
    noBuild: "아직 설치할 수 있는 빌드가 없습니다.",
    kind: {
      "android-debug": "Android 디버그 빌드",
      "android-release": "Android 릴리스 빌드",
      "ios-ad-hoc": "iOS Ad-hoc 빌드",
    },
  },
  en: {
    unavailableTitle: "This link is not available",
    unavailableBody:
      "The link expired or was revoked, or the app is not public. Ask the sender for a new link.",
    install: "Install",
    by: "Team",
    expires: "Link expires",
    escapeLead:
      "The browser inside this messenger may block installs. Open the page in your default browser.",
    escapeOpen: "Open in browser",
    escapeIos:
      "Open this page in Safari: use the share (or ⋯) menu and choose “Open in Safari”, or copy the link into Safari.",
    copy: "Copy link",
    copied: "Copied",
    apk: "Download APK",
    viaConsole: "Install with the console app",
    viaConsoleHint:
      "If the yyt console app is installed, it downloads and installs the build.",
    noConsoleApp:
      "The console app is not installed. Download the APK directly instead.",
    stepsTitle: "If the install is blocked",
    steps: [
      "When the download finishes, open the file from the notification or the downloads list.",
      "If Android mentions “unknown apps”, allow installs from the browser you are using (Chrome, …) in Settings and come back.",
      "If Play Protect warns you, open “More details” and choose “Install anyway”.",
      "If an update does not install (a build signed differently), uninstall the old app and install again.",
    ],
    installer: "Get the console app (members)",
    ios: "Install on iPhone/iPad",
    iosHint:
      "An ad-hoc build installs only on registered devices, and only from Safari.",
    desktop:
      "Scan the QR code with your phone to open this page there, or download the files directly.",
    noBuild: "No installable build yet.",
    kind: {
      "android-debug": "Android debug build",
      "android-release": "Android release build",
      "ios-ad-hoc": "iOS ad-hoc build",
    },
  },
} as const;

/** `en` when the first `Accept-Language` tag is English; Korean otherwise. */
export function shareLang(acceptLanguage: string | undefined): ShareLang {
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase();
  return first?.startsWith("en") ? "en" : "ko";
}

export function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

/** JSON inside `<script type="application/json">`: no `<` can end the element. */
function scriptJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const STYLE = `:root{color-scheme:light dark;--fg:#1d1d1f;--mut:#6b6b70;--bg:#fff;--box:#f4f4f6;--acc:#2f6fed}
@media (prefers-color-scheme:dark){:root{--fg:#ececf0;--mut:#a0a0a8;--bg:#121214;--box:#1e1e22;--acc:#3567d6}}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:34rem;margin:0 auto;padding:1.5rem 1rem 3rem}h1{font-size:1.5rem;margin:0 0 .25rem;overflow-wrap:anywhere}
.meta{color:var(--mut);font-size:.875rem;margin:0 0 1rem}.sum{white-space:pre-line;margin:0 0 1rem;overflow-wrap:anywhere}
section{background:var(--box);border-radius:12px;padding:1rem;margin:0 0 1rem}section p{margin:.25rem 0 .75rem}
.btn{display:block;width:100%;text-align:center;padding:.8rem 1rem;border-radius:10px;border:0;font:inherit;font-weight:600;text-decoration:none;cursor:pointer;margin:.5rem 0;background:var(--acc);color:#fff}
.btn.alt{background:transparent;color:var(--acc);border:1px solid var(--acc)}.hint{color:var(--mut);font-size:.875rem}
a{color:var(--acc)}ol{padding-left:1.25rem;margin:.5rem 0}li{margin:.25rem 0}details summary{cursor:pointer;color:var(--acc)}
.qr{display:flex;justify-content:center;margin:.5rem 0}.qr svg{width:200px;height:200px;background:#fff;padding:8px;border-radius:8px}
input{width:100%;font:inherit;padding:.5rem;border-radius:8px;border:1px solid var(--mut);background:var(--bg);color:var(--fg)}
[hidden]{display:none!important}.hero{display:block;max-width:100%;max-height:40vh;width:auto;height:auto;object-fit:contain;border-radius:12px;margin:0 auto 1rem;background:var(--box)}`;

// Runs once on load. Every target URL is built from the page data, never
// from `location`, so a crafted query cannot steer it.
const SCRIPT = `(function(){var d=JSON.parse(document.getElementById("d").textContent);
var ua=navigator.userAgent||"";var $=function(i){return document.getElementById(i)};
var show=function(i){var e=$(i);if(e)e.hidden=false};
var android=/Android/i.test(ua);
var ios=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&navigator.maxTouchPoints>1);
var kakao=/KAKAOTALK/i.test(ua);var line=/ Line\\//.test(ua);
var wv=android&&/; wv\\)/.test(ua);
var iosApp=ios&&(kakao||line||!/Safari\\//.test(ua)||/CriOS|FxiOS|EdgiOS/.test(ua));
var u=new URL(d.pageUrl);var hostPath=u.host+u.pathname;
var esc=$("escape-open");
if(kakao){esc.href="kakaotalk://web/openExternal?url="+encodeURIComponent(d.pageUrl);show("escape");show("escape-open");
 try{if(!sessionStorage.getItem("yyt-esc")){sessionStorage.setItem("yyt-esc","1");location.href=esc.href}}catch(e){}}
else if(line){var lu=d.pageUrl+(d.pageUrl.indexOf("?")<0?"?":"&")+"openExternalBrowser=1";esc.href=lu;show("escape");show("escape-open");
 if(location.search.indexOf("openExternalBrowser")<0)location.replace(lu)}
else if(wv){esc.href="intent://"+hostPath+"#Intent;scheme=https;package=com.android.chrome;end";show("escape");show("escape-open")}
if(iosApp){show("escape");show("escape-ios")}
if(android||ios)$("desktop").hidden=true;
if(android){show("android");var c=$("via-console");if(c)c.href="intent://"+hostPath+"#Intent;scheme=yytconsole;package=life.yyt.console;S.browser_fallback_url="+encodeURIComponent(d.pageUrl+"?noapp=1")+";end";
 if(/[?&]noapp=1/.test(location.search))show("noapp")}
else if(ios){show("ios")}
var cp=$("copy");cp.addEventListener("click",function(){var done=function(){cp.textContent=d.copied};
 if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(d.pageUrl).then(done,function(){show("link");$("link").select()})}
 else{show("link");$("link").select()}});
})();`;

const sha = (s: string) =>
  `'sha256-${createHash("sha256").update(s).digest("base64")}'`;
/** The page's CSP; an app image adds its CDN origin (only that origin) to `img-src`. */
function csp(imageOrigin?: string): string {
  return [
    "default-src 'none'",
    `script-src ${sha(SCRIPT)}`,
    `style-src ${sha(STYLE)}`,
    `img-src data:${imageOrigin ? ` ${imageOrigin}` : ""}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}
const CSP = csp();

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": CSP,
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex",
};

function shell(
  lang: ShareLang,
  head: {
    title: string;
    description: string;
    url: string | null;
    image?: { url: string; width: number; height: number } | null;
  },
  body: string,
  data: unknown,
): string {
  const og = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="yyt">`,
    `<meta property="og:title" content="${escapeHtml(head.title)}">`,
    `<meta property="og:description" content="${escapeHtml(head.description)}">`,
    head.url
      ? `<meta property="og:url" content="${escapeHtml(head.url)}">`
      : "",
    ...(head.image
      ? [
          `<meta property="og:image" content="${escapeHtml(head.image.url)}">`,
          `<meta property="og:image:width" content="${head.image.width}">`,
          `<meta property="og:image:height" content="${head.image.height}">`,
          `<meta property="og:image:alt" content="${escapeHtml(head.title)}">`,
          `<meta name="twitter:image" content="${escapeHtml(head.image.url)}">`,
        ]
      : []),
    // A wide image (a store feature graphic) gets the large card.
    `<meta name="twitter:card" content="${
      head.image && head.image.width > head.image.height
        ? "summary_large_image"
        : "summary"
    }">`,
    `<meta name="twitter:title" content="${escapeHtml(head.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(head.description)}">`,
  ].join("");
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${escapeHtml(head.title)}</title><meta name="description" content="${escapeHtml(head.description)}">${og}<style>${STYLE}</style></head><body><main>${body}</main>${
    data === undefined
      ? ""
      : `<script type="application/json" id="d">${scriptJson(data)}</script><script>${SCRIPT}</script>`
  }</body></html>`;
}

function date(sec: number, lang: ShareLang): string {
  const d = new Date(sec * 1000);
  // Fixed to KST: a Lambda has no viewer time zone, and the audience is Korean.
  return new Intl.DateTimeFormat(lang === "en" ? "en-US" : "ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(d);
}

export function renderSharePage(
  m: SharePageModel,
  lang: ShareLang,
): HttpResult {
  const t = T[lang];
  const version = m.android?.version ?? m.ios?.version ?? null;
  const heading = version ? `${m.title} ${version}` : m.title;
  const description =
    [...(m.summary?.split("\n")[0] ?? "")].slice(0, 200).join("") || t.install;
  const meta = [
    m.buildKind ? t.kind[m.buildKind] : "",
    m.teamName ? `${t.by} ${escapeHtml(m.teamName)}` : "",
    m.expiresAt !== null
      ? `${t.expires} ${escapeHtml(date(m.expiresAt, lang))}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const a = m.android;
  const i = m.ios;
  const downloads = [
    a ? `<a class="btn" href="${escapeHtml(a.url)}" download>${t.apk}</a>` : "",
  ].join("");
  const image = m.image ?? null;
  const body = `${
    image
      ? `<img class="hero" src="${escapeHtml(image.url)}" width="${image.width}" height="${image.height}" alt="">`
      : ""
  }<h1>${escapeHtml(heading)}</h1>${meta ? `<p class="meta">${meta}</p>` : ""}${
    m.summary ? `<p class="sum">${escapeHtml(m.summary)}</p>` : ""
  }
<section id="escape" hidden><p>${t.escapeLead}</p><a id="escape-open" class="btn" href="#" hidden>${t.escapeOpen}</a><p id="escape-ios" class="hint" hidden>${t.escapeIos}</p></section>
<section id="android" hidden>${
    a
      ? `<p id="noapp" class="hint" hidden>${t.noConsoleApp}</p>${downloads}<a id="via-console" class="btn alt" href="#">${t.viaConsole}</a><p class="hint">${t.viaConsoleHint}</p><details><summary>${t.stepsTitle}</summary><ol>${t.steps
          .map((s) => `<li>${s}</li>`)
          .join("")}</ol></details>`
      : `<p>${t.noBuild}</p>`
  }<p class="hint"><a href="${escapeHtml(m.installerUrl)}">${t.installer}</a></p></section>
<section id="ios" hidden>${
    i
      ? `<a class="btn" href="${escapeHtml(i.url)}">${t.ios}</a><p class="hint">${t.iosHint}</p>`
      : `<p>${t.noBuild}</p>`
  }</section>
<section id="desktop"><p>${t.desktop}</p><div class="qr" role="img" aria-label="QR">${m.qrSvg}</div>${downloads}${
    !a && !i ? `<p>${t.noBuild}</p>` : ""
  }</section>
<button id="copy" class="btn alt" type="button" aria-live="polite">${t.copy}</button><input id="link" readonly value="${escapeHtml(m.pageUrl)}" hidden>`;
  // Desktop is visible without JavaScript; the script hides it on a phone.
  const html = shell(
    lang,
    { title: heading, description, url: m.pageUrl, image },
    body,
    { pageUrl: m.pageUrl, copied: t.copied },
  );
  return {
    statusCode: 200,
    headers: {
      ...HEADERS,
      "content-security-policy": csp(
        image ? new URL(image.url).origin : undefined,
      ),
    },
    body: html,
  };
}

/** One page for every link that does not resolve, whatever the reason. */
export function renderShareUnavailable(lang: ShareLang): HttpResult {
  const t = T[lang];
  const html = shell(
    lang,
    { title: t.unavailableTitle, description: t.unavailableBody, url: null },
    `<h1>${t.unavailableTitle}</h1><p>${t.unavailableBody}</p>`,
    undefined,
  );
  return { statusCode: 404, headers: { ...HEADERS }, body: html };
}

export const SHARE_PAGE_CSP = CSP;
/** The bridge script, exported for the user-agent tests. */
export const SHARE_PAGE_SCRIPT = SCRIPT;
