/* Loads a bundle's `view` and its two sheets (JSON + PNG) once per bundle URL. */
import {
  checkView,
  parseActors,
  parseTiles,
  parseView,
  type Actors,
  type Tiles,
  type View,
} from "../../src/view.js";

export interface Sheets {
  view: View;
  tiles: Tiles;
  actors: Actors;
  tilesImage: HTMLImageElement;
  actorsImage: HTMLImageElement;
  /** `checkView` findings; the renderer draws placeholders for what is missing. */
  problems: string[];
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${res.status} for ${url.split("?")[0]}`);
  return res.json();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // The CDN answers `access-control-allow-origin: *`; anonymous keeps the canvas untainted.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image failed: ${url.split("?")[0]}`));
    img.src = url;
  });
}

export interface SheetLoader {
  /** `undefined` when the bundle has no `view` (the client draws the grid plainly). */
  load(bundleUrl: string): Promise<Sheets | undefined>;
}

export function createSheetLoader(): SheetLoader {
  const cache = new Map<string, Promise<Sheets | undefined>>();
  const sheetDocs = new Map<string, Promise<unknown>>();
  const images = new Map<string, Promise<HTMLImageElement>>();
  const once = <T>(
    m: Map<string, Promise<T>>,
    key: string,
    f: () => Promise<T>,
  ) => {
    let p = m.get(key);
    if (!p) {
      p = f();
      p.catch(() => m.delete(key));
      m.set(key, p);
    }
    return p;
  };
  return {
    load: (bundleUrl) =>
      once(cache, bundleUrl, async () => {
        const raw = (await getJson(bundleUrl)) as { view?: unknown };
        const view = parseView(raw.view, bundleUrl);
        if (!view) return undefined;
        const [tilesRaw, actorsRaw] = await Promise.all([
          once(sheetDocs, view.sheets.tiles, () => getJson(view.sheets.tiles)),
          once(sheetDocs, view.sheets.actors, () =>
            getJson(view.sheets.actors),
          ),
        ]);
        const tiles = parseTiles(tilesRaw, view.sheets.tiles);
        const actors = parseActors(actorsRaw, view.sheets.actors);
        const [tilesImage, actorsImage] = await Promise.all([
          once(images, tiles.image, () => loadImage(tiles.image)),
          once(images, actors.image, () => loadImage(actors.image)),
        ]);
        return {
          view,
          tiles,
          actors,
          tilesImage,
          actorsImage,
          problems: checkView(view, tiles, actors),
        };
      }),
  };
}
