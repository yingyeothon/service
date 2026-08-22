# better-sqlite3 Lambda layer

`./build.sh [version]` downloads the official prebuilt linux-arm64 binary for Node 22 (ABI 127, `NODE_TARGET` to override) via `prebuild-install` and zips it as `better-sqlite3-arm64.zip`. No Docker needed.

Each service's `serverless.yml` references it as:

```yaml
layers:
  betterSqlite3:
    package:
      artifact: ../../layers/better-sqlite3/better-sqlite3-arm64.zip
    compatibleRuntimes: [nodejs22.x]
    compatibleArchitectures: [arm64]
custom:
  esbuild:
    external: ["better-sqlite3"]
```

Always use `package.artifact` (not `path:`) — `path:` would zip `build.sh`/README and a stale zip into the layer. Run `./build.sh` before deploying if the zip is missing; it is git-ignored.
