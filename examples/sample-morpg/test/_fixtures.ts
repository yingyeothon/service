import { readFileSync } from "node:fs";
import { parseMapBundle, type MapBundle } from "../src/map.js";

/** Where the shipped bundles would live once published; relative zone URLs resolve against it. */
export const BUNDLE_BASE = "https://cdn.test/assets/v1/";

export function loadBundle(file: string): MapBundle {
  return parseMapBundle(
    JSON.parse(
      readFileSync(new URL(`../assets/${file}`, import.meta.url), "utf8"),
    ),
    `${BUNDLE_BASE}${file}`,
  );
}

/** The world bundle (town + slime field). */
export function loadZone(): MapBundle {
  return loadBundle("zone001.json");
}

/** The forest field a teleport leads to (no templates of its own). */
export function loadZone2(): MapBundle {
  return loadBundle("zone002.json");
}

/** Deterministic RNG (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
