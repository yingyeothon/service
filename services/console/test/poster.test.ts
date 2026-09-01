import { describe, expect, it } from "vitest";
import { createMemoryPosterStore } from "../src/poster.js";

describe("poster store listing", () => {
  it("refuses anything but a bare `dir/` prefix", async () => {
    const store = createMemoryPosterStore();
    store.put("shots/sh1/se1/a.png", {
      contentType: "image/png",
      contentLength: 1,
    });
    // The bucket is shared with `posters/` and `site-uploads/`, and the sweep
    // deletes what it lists: an empty prefix from a template or a config
    // lookup would take another feature's objects with it.
    for (const bad of ["", "shots", "/shots/", "shots/../posters/"])
      await expect(store.list(bad)).rejects.toMatchObject({
        code: "internal",
      });
  });

  it("lists one prefix in key order and says when it stopped short", async () => {
    const store = createMemoryPosterStore();
    const o = { contentType: "image/png", contentLength: 1 };
    store.put("shots/sh1/se1/b.png", o, 200);
    store.put("shots/sh1/se1/a.png", o, 100);
    store.put("posters/ev1/x.png", o, 100);
    const r = await store.list("shots/");
    // Sorted like S3, which returns keys lexicographically.
    expect(r.objects).toEqual([
      { key: "shots/sh1/se1/a.png", lastModifiedSec: 100 },
      { key: "shots/sh1/se1/b.png", lastModifiedSec: 200 },
    ]);
    expect(r.truncated).toBe(false);
    expect((await store.list("posters/")).objects).toHaveLength(1);
  });
});
