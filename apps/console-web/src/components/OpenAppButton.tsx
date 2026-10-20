import { Anchor, Button, Stack, Text } from "@mantine/core";
import { IconDeviceMobile } from "@tabler/icons-react";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import {
  appOpenIntentUrl,
  appOpenLinkUrl,
  appOpenPlatform,
  linkHostFor,
} from "../lib/appHandoff";
import { useAction } from "../lib/query";
import { Notice } from "./ui";

const icon = <IconDeviceMobile size={16} aria-hidden="true" />;

/**
 * "Open app": hands the web session to the 잉여톤 app on this phone
 * (todo/49, todo/76). Renders nothing where no handoff can work — a desktop,
 * an iPhone on a host without a link host — or for a pending member: the
 * exchange would refuse them anyway, so the button would only mint codes.
 */
export function OpenAppButton({
  nav,
  host,
  go = (url) => window.location.assign(url),
}: {
  /** Test seam for the platform check. */
  nav?: Partial<Navigator>;
  /** Test seam for the console host the link host is derived from. */
  host?: string;
  /** Test seam for the Android intent navigation. */
  go?: (url: string) => void;
}) {
  const { me } = useAuth();
  const consoleHost = host ?? window.location.host;
  const platform = appOpenPlatform(nav, consoleHost);
  if (!platform || !me || me.role === "pending") return null;
  return platform === "android" ? (
    <AndroidOpenApp go={go} />
  ) : (
    <IosOpenApp host={consoleHost} />
  );
}

/**
 * Android: the navigation happens right after the code arrives, inside
 * Chrome's user-activation window; the anchor that follows is the retry for
 * a slow network, and it disappears with the code's lifetime.
 */
function AndroidOpenApp({ go }: { go: (url: string) => void }) {
  const act = useAction();
  const [pending, setPending] = useState<{
    url: string;
    ttlSec: number;
  } | null>(null);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), pending.ttlSec * 1000);
    return () => clearTimeout(t);
  }, [pending]);

  const open = async () => {
    const r = await act.run(() => api.createAppHandoff());
    if (!r) return;
    const url = appOpenIntentUrl(window.location.origin, r.code);
    setPending({ url, ttlSec: r.expiresInSec });
    go(url);
  };

  return (
    <Stack gap={4}>
      <Button
        variant="default"
        leftSection={icon}
        onClick={() => void open()}
        disabled={act.busy}
        loading={act.busy}
      >
        Open app
      </Button>
      {pending && (
        <Text size="xs" c="dimmed">
          Signing you in to the app (Chrome or Samsung Internet). If it did not
          open, <Anchor href={pending.url}>open the app again</Anchor>.
        </Text>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}
    </Stack>
  );
}

/** Seconds shaved off the code's lifetime so the client link dies first. */
const IOS_EXPIRY_MARGIN_SEC = 3;
/** How long a tapped link lingers if the page never goes hidden. */
const IOS_SPENT_DROP_MS = 1000;

/**
 * iOS: two taps (decisions, _Console app and push on iOS_ #9). The first
 * mints the code; the second is a plain cross-domain `<a>` to the link host,
 * because iOS follows a Universal Link only on a real user tap and a
 * navigation after an `await` may not count as one. The link host must be
 * the one this console host maps to: a stage that answers without one, or
 * with another, gets a notice instead, and the minted code is dropped (it
 * expires unused). A tapped link is spent — whether the app or Safari took
 * it — so it is removed once the page hides (or shortly after the tap) and a
 * second tap on it is swallowed.
 */
function IosOpenApp({ host }: { host: string }) {
  const act = useAction();
  const [link, setLink] = useState<{ url: string; expiresAt: number } | null>(
    null,
  );
  const [left, setLeft] = useState(0);
  const [state, setState] = useState<
    "idle" | "expired" | "used" | "unsupported"
  >("idle");
  const [spent, setSpent] = useState(false);
  const spentRef = useRef(false);
  const anchorRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    if (!link) return;
    const tick = () => {
      const s = Math.ceil((link.expiresAt - Date.now()) / 1000);
      if (s > 0) return setLeft(s);
      setLink(null);
      setState("expired");
    };
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [link]);

  // Tap 2 needs the anchor: move focus there when it replaces the button.
  useEffect(() => {
    if (link) anchorRef.current?.focus();
  }, [link]);

  useEffect(() => {
    if (!spent) return;
    const drop = () => {
      setSpent(false);
      setLink(null);
      setState("used");
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") drop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", drop);
    const t = setTimeout(drop, IOS_SPENT_DROP_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", drop);
      clearTimeout(t);
    };
  }, [spent]);

  const mint = async () => {
    const r = await act.run(() => api.createAppHandoff());
    if (!r) return;
    const expected = linkHostFor(host);
    if (!r.linkHost || !expected || r.linkHost !== expected) {
      setState("unsupported");
      return;
    }
    const ttl = r.expiresInSec - IOS_EXPIRY_MARGIN_SEC;
    if (ttl <= 0) {
      setState("expired");
      return;
    }
    spentRef.current = false;
    setSpent(false);
    setState("idle");
    setLeft(ttl);
    setLink({
      url: appOpenLinkUrl(r.linkHost, r.code),
      expiresAt: Date.now() + ttl * 1000,
    });
  };

  // The first tap follows the link natively; any later tap on the same,
  // spent link is swallowed until the button comes back.
  const onLinkClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (spentRef.current) {
      e.preventDefault();
      return;
    }
    spentRef.current = true;
    setSpent(true);
  };

  if (link) {
    return (
      <Stack gap={4}>
        <Button
          component="a"
          href={link.url}
          ref={anchorRef}
          leftSection={icon}
          onClick={onLinkClick}
        >
          Open app
        </Button>
        <Text size="xs" role="status" aria-live="polite">
          Tap <strong>Open app</strong> again to sign in to the 잉여톤 app.
        </Text>
        <Text size="xs" c="dimmed">
          The link is valid for {left} s. If Safari opens instead, iOS stopped
          opening 잉여톤 from links: long-press <strong>Open app</strong> and
          choose <strong>Open in 잉여톤</strong> to turn that back on (that
          attempt may fail), then tap <strong>Open app</strong> again for a
          fresh link. In an in-app browser (KakaoTalk and the like), open this
          page in Safari first.
        </Text>
      </Stack>
    );
  }
  return (
    <Stack gap={4}>
      <Button
        variant="default"
        leftSection={icon}
        onClick={() => void mint()}
        disabled={act.busy || state === "unsupported"}
        loading={act.busy}
      >
        Open app
      </Button>
      {(state === "expired" || state === "used") && (
        <Text size="xs" c="dimmed" role="status" aria-live="polite">
          {state === "expired" ? "The sign-in link expired. " : ""}Tap{" "}
          <strong>Open app</strong> for a new link.
        </Text>
      )}
      {state === "unsupported" && (
        <Notice kind="warn">
          This environment does not support opening the iOS app. Sign in with
          the login QR on App login instead.
        </Notice>
      )}
      {act.error && <Notice kind="error">{act.error}</Notice>}
    </Stack>
  );
}
