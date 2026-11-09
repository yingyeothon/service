import { describe, expect, it } from "vitest";
import {
  attachmentRole,
  plain,
  safeBlob,
  safeHref,
  sniffImage,
  tracerErrorText,
} from "../src/lib/tracer";

// Rendering rules for device-sent tracer data (decisions tracer #12).

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe("tracer rendering safety", () => {
  it("knows an image by its magic bytes only", () => {
    expect(
      sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe("image/png");
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
    expect(sniffImage(text("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    for (const s of [
      "<svg xmlns='http://www.w3.org/2000/svg'/>",
      "<html>",
      "GIF89a",
      "RIFF\0\0\0\0WAVE",
      "",
    ])
      expect(sniffImage(text(s)), s).toBeNull();
    expect(sniffImage(bytes(0x89, 0x50))).toBeNull();
  });

  it("never makes a renderable blob of a non-image", () => {
    expect(safeBlob(text("<html><script>")).blob.type).toBe(
      "application/octet-stream",
    );
    expect(safeBlob(text("<svg onload=alert(1)>")).image).toBe(false);
    expect(safeBlob(bytes(0xff, 0xd8, 0xff)).blob.type).toBe("image/jpeg");
  });

  it("links http(s) only", () => {
    expect(safeHref("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHref("http://example.com")).toBe("http://example.com/");
    for (const s of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,x",
      "//evil.example",
      "vbscript:x",
      "https://",
      "mailto:a@b",
    ])
      expect(safeHref(s), s).toBeNull();
  });

  it("drops bidi overrides and caps length", () => {
    expect(plain("abc\u202edcba\u2066x")).toBe("abcdcbax");
    expect(plain("x".repeat(10), 4)).toBe("xxxx…");
  });

  it("tells screenshots and view hierarchies apart by Sentry's names", () => {
    expect(attachmentRole({ filename: "screenshot.png" })).toBe("screenshot");
    expect(attachmentRole({ filename: "screenshot-2.jpg" })).toBe("screenshot");
    expect(attachmentRole({ attachmentType: "event.view_hierarchy" })).toBe(
      "viewHierarchy",
    );
    expect(attachmentRole({ filename: "screenshot.svg" })).toBe("file");
  });

  it("names each failure", () => {
    expect(
      tracerErrorText({
        status: 503,
        details: { reason: "tracer_not_configured" },
      }),
    ).toMatch(/not configured/);
    expect(tracerErrorText({ status: 404 })).toMatch(/no access/);
    expect(
      tracerErrorText({ status: 503, details: { retryAfter: 30 } }),
    ).toMatch(/30 s/);
    expect(tracerErrorText({ status: 503 })).toMatch(/unavailable/);
  });
});
