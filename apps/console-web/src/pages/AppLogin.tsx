import { Anchor, Button, Card, Code, Stack, Text, Title } from "@mantine/core";
import { IconQrcode } from "@tabler/icons-react";
import QRCode from "qrcode";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { Notice } from "../components/ui";
import { useAction } from "../lib/query";

/** The payload the 잉여톤 app's QR scanner accepts (apps/console-app). */
export function appLoginPayload(token: string, origin: string): string {
  return JSON.stringify({ type: "yyt_api_key", apiKey: token, server: origin });
}

export function AppLoginPage() {
  const act = useAction();
  const [qr, setQr] = useState<{ name: string; dataUrl: string } | null>(null);

  const create = async () => {
    const name = `app ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
    const r = await act.run(() => api.createToken(name));
    if (!r) return;
    // Rendered locally: the token never leaves the browser except in the QR.
    const dataUrl = await QRCode.toDataURL(
      appLoginPayload(r.token, window.location.origin),
      { errorCorrectionLevel: "M", margin: 2, width: 320 },
    );
    setQr({ name: r.name, dataUrl });
  };

  return (
    <>
      <Title order={2} mb="sm">
        App login
      </Title>
      <Text size="sm" c="dimmed" mb="md">
        The <strong>잉여톤</strong> Android app signs in by scanning a QR code
        made here. Each QR mints a new API token in your name (it appears under{" "}
        <Anchor component={Link} to="/tokens">
          API tokens
        </Anchor>
        , revoke it there when the phone is gone) and is shown once — do not
        share it or leave it on screen. Get the app from{" "}
        <Anchor component={Link} to="/installer">
          Installer
        </Anchor>
        .
      </Text>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {qr ? (
        <Card withBorder padding="md" maw={400}>
          <Stack align="center" gap="xs">
            <img
              src={qr.dataUrl}
              alt="App login QR code"
              width={320}
              height={320}
              style={{ maxWidth: "100%", height: "auto" }}
            />
            <Text size="sm" c="dimmed">
              Token <Code>{qr.name}</Code> — scan it in the app (QR 코드 스캔),
              then close this page.
            </Text>
            <Button variant="default" onClick={() => setQr(null)}>
              Done
            </Button>
          </Stack>
        </Card>
      ) : (
        <Button
          leftSection={<IconQrcode size={16} />}
          onClick={() => void create()}
          disabled={act.busy}
        >
          Show login QR
        </Button>
      )}
    </>
  );
}
