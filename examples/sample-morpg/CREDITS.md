# Credits

## Art (`assets/view/`)

- `tiles.png` / `tiles.json` and `actors.png` / `actors.json` are packed by
  `scripts/pack-assets.mjs` from two 16 px sheets (a 1024×1024 tileset and a
  256×128 character sheet) that the repository owner generated with ChatGPT
  image generation in August 2026. No third-party asset pack is involved.
- Licence for these art files: [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/)
  (public domain dedication), as recorded in `docs/decisions.md` ("Sample MORPG
  GUI client", decision 4). It covers only the files under `assets/view/`; the
  rest of the repository is licensed separately.
- No further art is added; entities without their own drawing use substitutes
  declared in the bundles' `view` sections (e.g. the wolf is a tinted bat).

## Data

- `assets/zone*.json` and everything under `src/` are original to this repository.
