import { Box, Button, Code, Group, Table, VisuallyHidden } from "@mantine/core";
import { api } from "../api";
import { useConfirm } from "../lib/confirm";
import { useCursorList } from "../lib/cursor";
import { fmtRelative } from "../lib/format";
import { fmtBytes } from "../lib/limits";
import { notify } from "../lib/notify";
import { campaignProblem } from "../lib/pushCampaign";
import { useAction } from "../lib/query";
import type { PushUpload, PushUploadPage } from "../types";
import { DataTable } from "./DataTable";
import { Section } from "./Section";
import { Badge, Notice } from "./ui";

/*
 * The recipient files of a push channel (`GET …/push/uploads`,
 * `docs/push.md` *Job routes*): what holds the channel's pending places,
 * and a delete for the ones no unfinished job reads. The list carries no
 * object key and no URL.
 */

const NOWRAP = { whiteSpace: "nowrap" } as const;
/** Why an upload cannot be deleted while a job reads it. */
export const IN_USE_REASON =
  "An unfinished job reads this file; it can be deleted once the job ends.";
const inUseReasonId = (id: string) => `push-upload-in-use-${id}`;

/** The channel's uploads, newest first; `reload` after a form made or dropped one. */
export function usePushUploads(channelId: string) {
  return useCursorList<PushUploadPage, PushUpload>(
    ["channel", channelId, "push", "uploads"],
    (cursor) => api.pushUploads(channelId, cursor),
    (p) => p.uploads,
  );
}
export type PushUploadList = ReturnType<typeof usePushUploads>;

/** What an upload is doing now, as a word. */
export function uploadState(u: PushUpload): { label: string; tone: string } {
  if (u.inUse) return { label: "in use", tone: "accent" };
  if (u.pending) return { label: "pending", tone: "warn" };
  return { label: "used", tone: "neutral" };
}

export function PushUploadsSection({
  channelId,
  owner,
  uploads,
}: {
  channelId: string;
  /** A seated team member: may delete. */
  owner: boolean;
  uploads: PushUploadList;
}) {
  const confirm = useConfirm();
  const removeAct = useAction();
  const max = uploads.first?.max;
  const pending = uploads.rows?.filter((u) => u.pending).length;

  const remove = async (u: PushUpload) => {
    const ok = await confirm({
      title: "Delete recipient file?",
      message: `${u.id} (${fmtBytes(u.size)}) is removed with its stored file. A job that already finished keeps its report.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok.ok) return;
    const done = await removeAct.run(async () => {
      try {
        await api.deletePushUpload(channelId, u.id);
        return true;
      } catch (err) {
        throw new Error(campaignProblem(err, "upload").message);
      }
    });
    if (!done) return;
    notify.deleted("recipient file");
    await uploads.reload();
  };

  return (
    <Section
      title="Uploads"
      description={
        <>
          Recipient files of campaigns. A file is pending until a job names it
          and while an unfinished job reads it
          {max !== undefined && pending !== undefined && uploads.next === null
            ? ` (${pending} of ${max})`
            : ""}
          ; every file is removed two days after it was uploaded.
        </>
      }
    >
      {removeAct.error && <Notice kind="error">{removeAct.error}</Notice>}
      <DataTable
        columns={[
          { key: "id", label: "Upload" },
          { key: "size", label: "Size", align: "right" },
          { key: "state", label: "State" },
          { key: "by", label: "By" },
          { key: "at", label: "Uploaded" },
          { key: "until", label: "Usable until" },
          { key: "delete", label: <VisuallyHidden>Delete</VisuallyHidden> },
        ]}
        rows={uploads.rows}
        loading={uploads.loading}
        error={uploads.error}
        rowKey={(u) => u.id}
        minWidth={720}
        empty={{
          title: "No uploads.",
          hint: "A campaign uploads its CSV here when it is submitted.",
        }}
        render={(u) => {
          const s = uploadState(u);
          return (
            <>
              <Table.Td style={NOWRAP}>
                <Code style={{ userSelect: "all" }}>{u.id}</Code>
              </Table.Td>
              <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
                {fmtBytes(u.size)}
              </Table.Td>
              <Table.Td style={NOWRAP}>
                <Box
                  component="span"
                  style={{ display: "inline-block", minWidth: "max-content" }}
                >
                  <Badge tone={s.tone}>{s.label}</Badge>
                </Box>
              </Table.Td>
              <Table.Td style={NOWRAP}>
                {u.createdBy === "apikey"
                  ? "API key"
                  : (u.createdByLogin ?? u.createdBy)}
              </Table.Td>
              <Table.Td style={NOWRAP}>{fmtRelative(u.createdAt)}</Table.Td>
              <Table.Td style={NOWRAP}>{fmtRelative(u.usableUntil)}</Table.Td>
              <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
                {owner && (
                  <>
                    {/* The reason for a disabled delete: `title` for a
                        pointer, the description for a screen reader, and
                        the "in use" badge in the row for a tap. */}
                    {u.inUse && (
                      <VisuallyHidden id={inUseReasonId(u.id)}>
                        {IN_USE_REASON}
                      </VisuallyHidden>
                    )}
                    <Button
                      variant="default"
                      color="red"
                      size="compact-sm"
                      aria-label={`Delete ${u.id}`}
                      aria-describedby={
                        u.inUse ? inUseReasonId(u.id) : undefined
                      }
                      title={u.inUse ? IN_USE_REASON : undefined}
                      disabled={u.inUse || removeAct.busy}
                      onClick={() => void remove(u)}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </Table.Td>
            </>
          );
        }}
      />
      {uploads.next && (
        <Group justify="center" mt="sm">
          <Button
            variant="default"
            size="compact-sm"
            loading={uploads.busy}
            disabled={uploads.fetching}
            onClick={() => void uploads.loadMore()}
          >
            Load more
          </Button>
        </Group>
      )}
    </Section>
  );
}
