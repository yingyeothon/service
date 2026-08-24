import type { Logger } from "@yyt/core";
import type { CatalogAppRow, CatalogArtifactRow } from "@yyt/console-db";

/** Template variables: {{app}}, {{version}}, {{stage}}, {{platform}}, {{title}}. */
const DEFAULT_TEMPLATE = "{{app}} {{version}} ({{stage}}) uploaded";

export function buildSlackMessage(
  app: CatalogAppRow,
  artifact: CatalogArtifactRow,
): string {
  const template = app.messageTemplate?.trim() || DEFAULT_TEMPLATE;
  const tag = (k: string) => artifact.tags[k] ?? "";
  return template
    .replaceAll("{{app}}", app.name)
    .replaceAll("{{version}}", tag("version"))
    .replaceAll("{{stage}}", tag("stage"))
    .replaceAll("{{platform}}", artifact.platform)
    .replaceAll("{{title}}", tag("title"));
}

/**
 * Best-effort Slack webhook notification for a committed artifact. Never
 * throws: the upload already succeeded, so a broken hook only logs. The hook
 * URL comes straight from the app row (DB), is used once and never logged.
 */
export async function notifyNewArtifact({
  app,
  artifact,
  fetchFn = fetch,
  logger,
}: {
  app: CatalogAppRow;
  artifact: CatalogArtifactRow;
  fetchFn?: typeof fetch;
  logger: Logger;
}): Promise<void> {
  const hook = app.slackHookUrl?.trim();
  if (!hook) return;
  try {
    const r = await fetchFn(hook, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: buildSlackMessage(app, artifact),
        ...(app.slackChannel?.trim()
          ? { channel: app.slackChannel.trim() }
          : {}),
      }),
      // Must fit inside the remaining Lambda budget after the S3/DB work of
      // commit; a hanging webhook must not turn a committed upload into a 5xx.
      signal: AbortSignal.timeout(3_000),
    });
    if (!r.ok)
      logger.warn("slack notify failed", { app: app.name, status: r.status });
  } catch (e) {
    logger.warn("slack notify failed", {
      app: app.name,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
