import { Button, Card, Group, Stack, Text, Title } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { fmtTime } from "../lib/format";
import { useAction } from "../lib/query";
import type { Comment } from "../types";
import { Confirm, ConfirmWithReason, Notice } from "./ui";
import { Markdown } from "./Markdown";
import { MdField } from "./MdField";

/**
 * Comment thread under an issue or a discussion. Editing is the author's,
 * deleting is the author's or an owner's — the API decides, the props only
 * hide what would 403.
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
   * *Show (console)*, decision 12); the three older call sites leave it off
   * and keep their plain confirm.
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

  return (
    <>
      <Title order={4} mt="md" mb="xs">
        Comments {comments.length ? `(${comments.length})` : ""}
      </Title>
      {act.error && <Notice kind="error">{act.error}</Notice>}
      {comments.length === 0 && (
        <Text size="sm" c="dimmed">
          No comments yet.
        </Text>
      )}
      {comments.map((c) => (
        <Card withBorder mb="xs" padding="sm" key={c.id}>
          <Text size="xs" c="dimmed">
            {c.createdBy ?? "—"} · {fmtTime(c.createdAt)}
            {c.updatedAt !== c.createdAt && " · edited"}
          </Text>
          {editing?.id === c.id ? (
            <form onSubmit={(e) => void saveEdit(e)}>
              <Stack gap="xs" mt="xs">
                <MdField
                  label="Edit comment"
                  value={editing.bodyMd}
                  onChange={(bodyMd) => setEditing({ ...editing, bodyMd })}
                  maxLength={10000}
                  minRows={3}
                />
                <Group>
                  <Button
                    type="submit"
                    size="compact-sm"
                    disabled={act.busy || !editing.bodyMd.trim()}
                  >
                    Save
                  </Button>
                  <Button
                    size="compact-sm"
                    variant="default"
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </Button>
                </Group>
              </Stack>
            </form>
          ) : (
            <>
              <Markdown text={c.bodyMd} />
              {(c.mine || owner) && (
                <Group gap="xs" mt={4}>
                  {c.mine && canPost && (
                    <Button
                      size="compact-xs"
                      variant="default"
                      onClick={() => setEditing({ id: c.id, bodyMd: c.bodyMd })}
                    >
                      Edit
                    </Button>
                  )}
                  {reasonOnForeignDelete && !c.mine ? (
                    <ConfirmWithReason
                      label="Delete"
                      required
                      placeholder="Why is this being removed?"
                      disabled={act.busy}
                      onConfirm={(reason) =>
                        void act.run(() => onDelete(c.id, reason))
                      }
                    />
                  ) : (
                    <Confirm
                      label="Delete"
                      onConfirm={() => void act.run(() => onDelete(c.id))}
                      disabled={act.busy}
                    />
                  )}
                </Group>
              )}
            </>
          )}
        </Card>
      ))}
      {canPost && (
        <form onSubmit={(e) => void submit(e)}>
          <Stack gap="xs" mt="sm">
            <MdField
              label="New comment"
              value={draft}
              onChange={setDraft}
              maxLength={10000}
              minRows={3}
            />
            <Group>
              <Button type="submit" disabled={act.busy || !draft.trim()}>
                Comment
              </Button>
            </Group>
          </Stack>
        </form>
      )}
    </>
  );
}
