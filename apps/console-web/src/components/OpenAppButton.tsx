import { Anchor, Button, Stack, Text } from "@mantine/core";
import { IconDeviceMobile } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { appOpenIntentUrl, isAndroidBrowser } from "../lib/appHandoff";
import { useAction } from "../lib/query";
import { Notice } from "./ui";

/**
 * "Open app": hands the web session to the 잉여톤 app on this phone
 * (todo/49). Renders nothing off Android or for a pending member — the
 * exchange would refuse them anyway, so the button would only mint codes.
 *
 * The navigation happens right after the code arrives, inside Chrome's
 * user-activation window; the anchor that follows is the retry for a slow
 * network, and it disappears with the code's lifetime.
 */
export function OpenAppButton({
  nav,
  go = (url) => window.location.assign(url),
}: {
  /** Test seam for the platform check. */
  nav?: Partial<Navigator>;
  /** Test seam for the intent navigation. */
  go?: (url: string) => void;
}) {
  const { me } = useAuth();
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
  if (!isAndroidBrowser(nav) || !me || me.role === "pending") return null;

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
        leftSection={<IconDeviceMobile size={16} aria-hidden="true" />}
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
