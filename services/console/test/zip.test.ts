import { describe, expect, it } from "vitest";
import { readSiteZip, sitePath, ZipError } from "../src/zip.js";
import { siteObjectHeaders } from "../src/site-deploy.js";
import { makeZip, siteZip } from "./zipfix.js";

const LIMITS = { maxEntries: 100, maxTotalBytes: 1024 * 1024 };
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ZipError) return e.code;
    throw e;
  }
  return "ok";
};

describe("sitePath", () => {
  it("keeps ordinary build output and drops residue", () => {
    expect(sitePath("index.html")).toBe("index.html");
    expect(sitePath("assets/index-B3xk9Qz1.js")).toBe(
      "assets/index-B3xk9Qz1.js",
    );
    expect(sitePath("_app/immutable/chunks/[slug]+page.js")).toBe(
      "_app/immutable/chunks/[slug]+page.js",
    );
    expect(sitePath("Build/game.wasm.br")).toBe("Build/game.wasm.br");
    expect(sitePath("@fs/x~1(2)=3.txt")).toBe("@fs/x~1(2)=3.txt");
    for (const dropped of [
      "assets/",
      ".DS_Store",
      ".git/config",
      "__MACOSX/._index.html",
      "a/.hidden/b.js",
    ])
      expect(sitePath(dropped), dropped).toBeUndefined();
  });

  it("refuses anything that could leave or alias the prefix", () => {
    for (const bad of [
      "../x.html",
      "a/../../x.html",
      "/index.html",
      "a//b.js",
      "./a.js",
      "a\\b.js",
      "a b.js",
      "a\tb.js",
      "café.js",
      "a;b.js",
      "a%2e%2e/b.js",
      "x".repeat(600),
      Array.from({ length: 17 }, () => "d").join("/") + "/f.js",
      "a\x00b.js",
    ])
      expect(() => sitePath(bad), bad).toThrow(ZipError);
    for (const name of ["constructor/x.js", "__proto__.js", "hasOwnProperty"])
      expect(sitePath(name)).toBe(name);
  });
});

describe("readSiteZip", () => {
  it("reads stored, deflated and data-descriptor entries and skips directories", () => {
    const files = readSiteZip(siteZip("hi"), LIMITS);
    expect(files.map((f) => f.path)).toEqual([
      "index.html",
      "config.json",
      "assets/index-B3xk9Qz1.js",
    ]);
    expect(files[2]!.data.toString()).toBe("console.log(1)");
    expect(files[1]!.data.toString()).toBe('{"marker":"hi"}');
    const stored = readSiteZip(
      makeZip([{ name: "index.html", data: "x", method: 0 }]),
      LIMITS,
    );
    expect(stored[0]!.data.toString()).toBe("x");
    // A trailing archive comment does not hide the EOCD.
    expect(
      readSiteZip(
        makeZip([{ name: "index.html", data: "x" }], { comment: "hello" }),
        LIMITS,
      ),
    ).toHaveLength(1);
  });

  it("unwraps a zipped folder only when nothing sits at the root", () => {
    const wrapped = makeZip([
      { name: "dist/", data: "" },
      { name: "dist/index.html", data: "a" },
      { name: "dist/assets/app.js", data: "b" },
    ]);
    expect(readSiteZip(wrapped, LIMITS).map((f) => f.path)).toEqual([
      "index.html",
      "assets/app.js",
    ]);
    // Two top-level directories and no root index: not a wrapper.
    expect(
      code(() =>
        readSiteZip(
          makeZip([
            { name: "a/index.html", data: "a" },
            { name: "b/index.html", data: "b" },
          ]),
          LIMITS,
        ),
      ),
    ).toBe("zip_no_index_html");
    // Root index present: the folder is a real subdirectory.
    expect(
      readSiteZip(
        makeZip([
          { name: "index.html", data: "a" },
          { name: "dist/index.html", data: "b" },
        ]),
        LIMITS,
      ).map((f) => f.path),
    ).toEqual(["index.html", "dist/index.html"]);
  });

  it("drops symlinks and dot-files, refuses escapes", () => {
    const files = readSiteZip(
      makeZip([
        { name: "index.html", data: "a" },
        { name: "link", data: "../../etc/passwd", mode: 0o120777 },
        { name: ".env", data: "SECRET=1" },
      ]),
      LIMITS,
    );
    expect(files.map((f) => f.path)).toEqual(["index.html"]);
    expect(
      code(() =>
        readSiteZip(
          makeZip([
            { name: "index.html", data: "a" },
            { name: "../other/index.html", data: "evil" },
          ]),
          LIMITS,
        ),
      ),
    ).toBe("zip_path_rejected");
  });

  it("enforces the caps while inflating, whatever the headers claim", () => {
    const big = Buffer.alloc(200 * 1024, 0);
    // Declared honestly but over the cap.
    expect(
      code(() =>
        readSiteZip(
          makeZip([
            { name: "index.html", data: "a" },
            { name: "big.bin", data: big },
          ]),
          { maxEntries: 10, maxTotalBytes: 100 * 1024 },
        ),
      ),
    ).toBe("zip_too_large");
    // Declared as tiny, actually big: the inflater's own limit catches it.
    expect(
      code(() =>
        readSiteZip(
          makeZip([
            { name: "index.html", data: "a" },
            { name: "big.bin", data: big, claimUncompressed: 10 },
          ]),
          { maxEntries: 10, maxTotalBytes: 100 * 1024 },
        ),
      ),
    ).toBe("zip_too_large");
    // Sum over entries, not per entry.
    const half = Buffer.alloc(60 * 1024, 1);
    expect(
      code(() =>
        readSiteZip(
          makeZip([
            { name: "index.html", data: "a" },
            { name: "a.bin", data: half },
            { name: "b.bin", data: half },
          ]),
          { maxEntries: 10, maxTotalBytes: 100 * 1024 },
        ),
      ),
    ).toBe("zip_too_large");
    expect(
      code(() =>
        readSiteZip(
          makeZip(
            Array.from({ length: 5 }, (_, i) => ({
              name: i === 0 ? "index.html" : `f${i}.txt`,
              data: "x",
            })),
          ),
          { maxEntries: 4, maxTotalBytes: 1000 },
        ),
      ),
    ).toBe("zip_too_many_entries");
    // A lying-small claim on a stored entry is a size mismatch, not a pass.
    expect(
      code(() =>
        readSiteZip(
          makeZip([
            { name: "index.html", data: "a" },
            { name: "s.bin", data: "hello", method: 0, claimUncompressed: 1 },
          ]),
          LIMITS,
        ),
      ),
    ).toBe("zip_corrupt");
  });

  it("refuses what it does not implement rather than guessing", () => {
    expect(
      code(() => readSiteZip(Buffer.from("not a zip at all"), LIMITS)),
    ).toBe("zip_not_a_zip");
    expect(code(() => readSiteZip(Buffer.alloc(0), LIMITS))).toBe(
      "zip_not_a_zip",
    );
    expect(
      code(() =>
        readSiteZip(
          makeZip([{ name: "index.html", data: "a", flags: 0x0001 }]),
          LIMITS,
        ),
      ),
    ).toBe("zip_unsupported");
    // zip64 marker in the EOCD entry count.
    expect(
      code(() =>
        readSiteZip(
          makeZip([{ name: "index.html", data: "a" }], { eocdCount: 0xffff }),
          LIMITS,
        ),
      ),
    ).toBe("zip_unsupported");
    // A count larger than the entries present walks off the directory.
    expect(
      code(() =>
        readSiteZip(
          makeZip([{ name: "index.html", data: "a" }], { eocdCount: 2 }),
          LIMITS,
        ),
      ),
    ).toBe("zip_corrupt");
    expect(
      code(() =>
        readSiteZip(makeZip([{ name: "page.html", data: "a" }]), LIMITS),
      ),
    ).toBe("zip_no_index_html");
    expect(
      code(() =>
        readSiteZip(
          makeZip([
            { name: "index.html", data: "a" },
            { name: "index.html", data: "b" },
          ]),
          LIMITS,
        ),
      ),
    ).toBe("zip_path_rejected");
  });
});

describe("siteObjectHeaders", () => {
  it("types by extension, encodes pre-compressed files, caches by shape", () => {
    expect(siteObjectHeaders("index.html")).toEqual({
      contentType: "text/html; charset=utf-8",
      cacheControl: "no-cache",
    });
    expect(siteObjectHeaders("config.json").cacheControl).toBe("no-cache");
    expect(siteObjectHeaders("assets/index-B3xk9Qz1.js")).toEqual({
      contentType: "text/javascript; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    });
    expect(
      siteObjectHeaders("_app/immutable/chunks/entry.a1b2c3d4.css"),
    ).toEqual({
      contentType: "text/css; charset=utf-8",
      cacheControl: "public, max-age=31536000, immutable",
    });
    // Flutter's unhashed assets/ and a hashed name outside the known dirs are
    // both short-lived: the invalidation clears the edge, the browser
    // revalidates after five minutes.
    expect(siteObjectHeaders("assets/fonts/MaterialIcons-Regular.otf")).toEqual(
      { contentType: "font/otf", cacheControl: "public, max-age=300" },
    );
    expect(siteObjectHeaders("main.dart.js").cacheControl).toBe(
      "public, max-age=300",
    );
    expect(siteObjectHeaders("Build/game.wasm.br")).toEqual({
      contentType: "application/wasm",
      cacheControl: "public, max-age=300",
      contentEncoding: "br",
    });
    expect(siteObjectHeaders("Build/game.data.gz")).toEqual({
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=300",
      contentEncoding: "gzip",
    });
    expect(siteObjectHeaders("Build/game.unityweb").contentType).toBe(
      "application/octet-stream",
    );
    expect(siteObjectHeaders("weird.xyz").contentType).toBe(
      "application/octet-stream",
    );
    expect(siteObjectHeaders("noext").contentType).toBe(
      "application/octet-stream",
    );
    expect(siteObjectHeaders("icon.svg").contentType).toBe("image/svg+xml");
  });
});

describe("readSiteZip bounds", () => {
  it("keeps forged offsets and lengths inside the archive", () => {
    expect(
      code(() =>
        readSiteZip(
          makeZip([
            { name: "index.html", data: "a" },
            { name: "x.txt", data: "b", forgeLocalOffset: 0x7fffffff },
          ]),
          LIMITS,
        ),
      ),
    ).toBe("zip_corrupt");
    expect(
      code(() =>
        readSiteZip(
          makeZip([
            { name: "index.html", data: "a" },
            {
              name: "x.txt",
              data: "hello",
              method: 0,
              claimCompressed: 0x100000,
            },
          ]),
          LIMITS,
        ),
      ),
    ).toBe("zip_corrupt");
    // Two entries sharing one local header is harmless: both bodies count.
    expect(
      readSiteZip(
        makeZip([
          { name: "index.html", data: "a", method: 0 },
          { name: "x.txt", data: "a", method: 0, forgeLocalOffset: 0 },
        ]),
        LIMITS,
      ).map((f) => f.data.toString()),
    ).toEqual(["a", "a"]);
    // Directory entries never count toward the file cap.
    expect(
      readSiteZip(
        makeZip([
          { name: "d/", data: "" },
          { name: "e/", data: "" },
          { name: "index.html", data: "a" },
        ]),
        { maxEntries: 1, maxTotalBytes: 100 },
      ),
    ).toHaveLength(1);
  });
});
