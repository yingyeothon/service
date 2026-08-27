import { readFileSync } from "node:fs";
import { parseMapBundle, type MapBundle } from "../src/map.js";

export function loadZone(): MapBundle {
  return parseMapBundle(
    JSON.parse(
      readFileSync(new URL("../assets/zone001.json", import.meta.url), "utf8"),
    ),
  );
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
