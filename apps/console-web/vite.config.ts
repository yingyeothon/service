import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The SPA lives under `/ui/` on the console host so its routes never collide
 * with the API's root paths (`/events`, `/channels`, …). In dev, everything
 * outside `/ui/` is proxied to a deployed console API; the proxy rewrites
 * `Origin` so the API's same-origin CSRF check accepts cookie-authenticated
 * mutations coming from localhost — but only for requests that really come
 * from this dev server, otherwise any site the developer visits could use the
 * proxy as a CSRF / debug-login oracle.
 */
export default defineConfig(({ mode }) => {
  const target = process.env.VITE_API_PROXY ?? "https://console-dev.yyt.life";
  // Dev-only convenience: with YYT_DEBUG_KEY set, the proxy attaches the
  // header console's `POST /debug/login` needs, so a synthetic session can be
  // minted from the browser console without pasting the key into the page.
  const debugKey = process.env.YYT_DEBUG_KEY;
  const isSelf = (origin: string | undefined, host: string | undefined) =>
    origin === undefined || (host !== undefined && origin === `http://${host}`);
  return {
    base: "/ui/",
    plugins: [react()],
    build: { outDir: "dist", sourcemap: true },
    server:
      mode === "development"
        ? {
            proxy: {
              "^/(?!ui/|ui$|@|node_modules/|src/|favicon\\.ico$).*": {
                target,
                changeOrigin: true,
                bypass: (req, res) => {
                  const origin = req.headers.origin;
                  const referer = req.headers.referer;
                  const host = req.headers.host;
                  const refOrigin = referer
                    ? (() => {
                        try {
                          return new URL(referer).origin;
                        } catch {
                          return "invalid";
                        }
                      })()
                    : undefined;
                  if (isSelf(origin, host) && isSelf(refOrigin, host)) return;
                  if (res) {
                    res.statusCode = 403;
                    res.end("cross-origin request refused by the dev proxy");
                  }
                  return false;
                },
                configure: (proxy) => {
                  proxy.on("proxyReq", (req) => {
                    if (req.getHeader("origin"))
                      req.setHeader("origin", target);
                    // The API may compare Referer's origin too; drop it rather
                    // than forward localhost.
                    req.removeHeader("referer");
                    if (debugKey && req.path === "/debug/login")
                      req.setHeader("x-debug-key", debugKey);
                  });
                },
              },
            },
          }
        : undefined,
  };
});
