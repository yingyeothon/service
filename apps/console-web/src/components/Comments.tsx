import { Box, Group, Stack, Text } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { fmtTime } from "../lib/format";
import { useAction } from "../lib/query";
import type { Comment } from "../types";
import { Markdown } from "./Markdown";
import { MdField } from "./MdField";
import { FormFooter } from "./ResourceDrawer";
import { RowMenu, type RowMenuItem } from "./RowMenu";
import { Section } from "./Section";
import { Notice } from "./ui";

/**
 * Comment thread under an issue, a discussion, an event or an entry. Editing
 * is the author's, deleting is the author's or an owner's — the API decides,
 * the props only hide what would 403. Each comment's verbs sit in its menu;
 * deleting confirms in a modal.
 */
export function Comments({
  comments,
  canPost,
  owner,
  reasonOnForeignDelete = false,
  onAdd,
  onEdit,
  onDelete,
}: {
  comments: Comment[];
  canPost: boolean;
  owner: boolean;
  /**
   * Demand a stated reason before deleting somebody else's comment. Set only
   * where an operator may act beyond their own content (`docs/decisions.md`
   * *Show (console)*, decision 12).
   */
  reasonOnForeignDelete?: boolean;
  onAdd: (bodyMd: string) => Promise<unknown>;
  onEdit: (id: string, bodyMd: string) => Promise<unknown>;
  onDelete: (id: string, reason?: string) => Promise<unknown>;
}) {
  const act = useAction();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; bodyMd: string } | null>(
    null,
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim()) return;
    if (await act.run(() => onAdd(draft))) setDraft("");
  };
  const saveEdit = async (e: FormEvent) => {
    e.preventDefault();
    if (!editing || !editing.bodyMd.trim()) return;
    if (await act.run(() => onEdit(editing.id, editing.bodyMd)))
      setEditing(null);
  };
  const items = (c: Comment): RowMenuItem[] => {
    const out: RowMenuItem[] = [];
    if (c.mine && canPost)
      out.push({
        label: "Edit",
        onClick: () => setEditing({ id: c.id, bodyMd: c.bodyMd }),
      });
    if (c.mine || owner)
      out.push({
        label: "Delete",
        danger: true,
        disabled: act.busy,
        onClick: async (reason) => {
          await act.run(() => onDelete(c.id, reason));
        },
        confirm: {
          title: "Delete this comment?",
          confirmLabel: "Delete",
          danger: true,
          reason:
            reasonOnForeignDelete && !c.mine
              ? { required: true, placeholder: "Why is this being removed?" }
              : undefined,
        },
      });
    return out;
  };

  return (
    <Section
      title={`Comments${comments.length ? ` (${comments.length})` : ""}`}
    >
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {comments.length === 0 && (
        <Text size="sm" c="dimmed">
          No comments yet.
        </Text>
      )}
      <Stack gap="md">
        {comments.map((c) => (
          <Box
            key={c.id}
            component="article"
            pl="md"
            style={{ borderLeft: "2px solid var(--yyt-hairline)" }}
          >
            <Group justify="space-between" align="center" mb={4}>
              <Text size="xs" c="dimmed">
                <strong>{c.createdBy ?? "—"}</strong> · {fmtTime(c.createdAt)}
                {c.updatedAt !== c.createdAt && " · edited"}
              </Text>
              <RowMenu
                name={`comment by ${c.createdBy ?? "unknown"}`}
                items={items(c)}
              />
            </Group>
            {editing?.id === c.id ? (
              <form onSubmit={(e) => void saveEdit(e)}>
                <Stack gap="sm">
                  <MdField
                    label="Edit comment"
                    value={editing.bodyMd}
                    onChange={(bodyMd) => setEditing({ ...editing, bodyMd })}
                    maxLength={10000}
                    minRows={3}
                  />
                  <FormFooter
                    submitLabel="Save"
                    busy={act.busy}
                    disabled={!editing.bodyMd.trim()}
                    onCancel={() => setEditing(null)}
                  />
                </Stack>
              </form>
            ) : (
              <Markdown text={c.bodyMd} />
            )}
          </Box>
        ))}
      </Stack>
      {canPost && (
        <form onSubmit={(e) => void submit(e)}>
          <Stack gap="sm" mt="lg">
            <MdField
              label="New comment"
              value={draft}
              onChange={setDraft}
              maxLength={10000}
              minRows={3}
            />
            <Group>
              <FormFooter
                submitLabel="Post comment"
                busy={act.busy}
                disabled={!draft.trim()}
              />
            </Group>
          </Stack>
        </form>
      )}
    </Section>
  );
}
