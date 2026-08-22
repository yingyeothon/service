import type { AppError } from "@yyt/core";
import type { HttpResult } from "@yyt/http";

function escape(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
}

const TITLES: Record<number, string> = {
  400: "잘못된 요청",
  401: "인증 실패",
  403: "허용되지 않은 요청",
  404: "채널을 찾을 수 없습니다",
  410: "만료된 채널입니다",
  500: "오류가 발생했습니다",
};

/** Minimal HTML for browser-facing failures (`/start`, `/callback`). No token, no stack. */
export function errorPage(err: AppError): HttpResult {
  const title = TITLES[err.status] ?? TITLES[500]!;
  const body = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:.1rem .3rem}</style></head><body><h1>${escape(title)}</h1><p>${escape(err.message)}</p><p><code>${escape(err.code)}</code></p></body></html>`;
  return {
    statusCode: err.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    body,
  };
}
