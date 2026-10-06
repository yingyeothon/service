import { Button, Code, Table, Text, TextInput } from "@mantine/core";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { fmtRelative, fmtTime } from "../lib/format";
import { notify } from "../lib/notify";
import {
  campaignProblem,
  emptyMessage,
  hasProblems,
  messageForm,
  messageProblems,
  messageText,
  templateNameProblem,
  type MessageForm,
} from "../lib/pushCampaign";
import { useAction, type AsyncState } from "../lib/query";
import type {
  PushTemplate,
  PushTemplateInput,
  PushTemplateList,
} from "../types";
import { DataTable } from "./DataTable";
import { FoldCell } from "./FoldCell";
import {
  MessageBox,
  MessageFields,
  MessagePreview,
  VarCodes,
} from "./PushMessageFields";
import { ResourceDrawer, useDrawerForm } from "./ResourceDrawer";
import { RowMenu } from "./RowMenu";
import { Section } from "./Section";
import { Notice } from "./ui";

/*
 * The templates of a push channel (`docs/push.md` *Templates*): a list, and
 * one drawer to write or edit a message with its `{{variables}}`, checked by
 * the server's rules before it is sent and previewed with sample values.
 */

const NOWRAP = { whiteSpace: "nowrap" } as const;

interface TemplateForm extends MessageForm {
  name: string;
}

const sameData = (a: Record<string, string>, b: Record<string, string>) =>
  JSON.stringify(Object.entries(a).sort()) ===
  JSON.stringify(Object.entries(b).sort());

export function PushTemplatesSection({
  channelId,
  owner,
  templates,
}: {
  channelId: string;
  owner: boolean;
  templates: AsyncState<PushTemplateList>;
}) {
  const act = useAction();
  const removeAct = useAction();
  const [editing, setEditing] = useState<PushTemplate | null>(null);
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [nameError, setNameError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const drawer = useDrawerForm<TemplateForm>(() => ({
    name: "",
    ...emptyMessage(),
  }));
  const f = drawer.form;
  const list = templates.data;
  const full = list !== undefined && list.templates.length >= list.max;

  const open = (t: PushTemplate | null) => {
    act.clear();
    setEditing(t);
    setSamples({});
    setNameError(null);
    setTried(false);
    drawer.open();
    // After `open()`, which seeds an empty form.
    if (t) drawer.setForm({ name: t.name, ...messageForm(t) });
  };

  const problems = messageProblems(f);
  const nameProblem = templateNameProblem(f.name);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    setNameError(null);
    if (nameProblem || hasProblems(problems)) return;
    const text = messageText(f);
    // An edit sends what differs from the template the drawer opened with.
    const body: Partial<PushTemplateInput> = editing
      ? {
          ...(f.name !== editing.name ? { name: f.name } : {}),
          ...(text.title !== editing.title ? { title: text.title } : {}),
          ...(text.body !== editing.body ? { body: text.body } : {}),
          ...(!sameData(text.data, editing.data) ? { data: text.data } : {}),
        }
      : { name: f.name, ...text };
    if (editing && !hasProblems(body)) return drawer.close();
    const r = await act.run(async () => {
      try {
        return editing
          ? await api.updatePushTemplate(channelId, editing.id, body)
          : await api.createPushTemplate(channelId, {
              name: f.name,
              ...text,
            });
      } catch (err) {
        const p = campaignProblem(err, "template");
        if (p.at === "name") {
          setNameError(p.message);
          return undefined;
        }
        throw new Error(p.message);
      }
    });
    if (!r) return;
    drawer.close();
    if (editing) notify.saved("template");
    else notify.created("template");
    await templates.reload();
  };
  const remove = async (t: PushTemplate) => {
    const ok = await removeAct.run(async () => {
      try {
        await api.deletePushTemplate(channelId, t.id);
        return true;
      } catch (err) {
        throw new Error(campaignProblem(err, "template").message);
      }
    });
    if (!ok) return;
    drawer.close();
    notify.deleted("template");
    await templates.reload();
  };

  return (
    <Section
      title="Templates"
      description={
        <>
          Messages a campaign fills in per recipient: a{" "}
          <Code>{"{{variable}}"}</Code> is replaced by the CSV column of that
          name.
          {list && ` ${list.templates.length} of ${list.max}.`}
          {full && " Delete one to add another."}
        </>
      }
      actions={
        owner && (
          <Button variant="default" disabled={full} onClick={() => open(null)}>
            New template
          </Button>
        )
      }
    >
      {removeAct.error && <Notice kind="error">{removeAct.error}</Notice>}
      <DataTable
        columns={[
          { key: "name", label: "Name" },
          { key: "title", label: "Title" },
          { key: "variables", label: "Variables" },
          { key: "updated", label: "Updated" },
        ]}
        rows={list?.templates}
        loading={templates.loading}
        error={templates.error}
        rowKey={(t) => t.id}
        minWidth={640}
        empty={{
          title: "No templates yet.",
          hint: "A campaign and a broadcast both start from one.",
        }}
        render={(t) => (
          <>
            <Table.Td style={NOWRAP}>
              <FoldCell
                label={t.name}
                what={`Template ${t.name}`}
                width={170}
                detail={
                  <>
                    <Text size="sm">
                      id <Code style={{ userSelect: "all" }}>{t.id}</Code>
                    </Text>
                    <Text size="sm" c="dimmed">
                      Updated {fmtTime(t.updatedAt)} by{" "}
                      {t.updatedByLogin ?? t.updatedBy} · created{" "}
                      {fmtTime(t.createdAt)} by{" "}
                      {t.createdByLogin ?? t.createdBy}
                    </Text>
                  </>
                }
                tooltip={`${t.name} · ${t.id}`}
              />
            </Table.Td>
            <Table.Td style={NOWRAP}>
              <FoldCell
                label={t.title === "" ? "(data only)" : t.title}
                ariaLabel={`${t.title === "" ? "(data only)" : t.title} — message of ${t.name}`}
                what={`Message of ${t.name}`}
                width={240}
                dimmed={t.title === ""}
                detail={<MessageBox message={t} label={`Text of ${t.name}`} />}
                tooltip={
                  t.title === ""
                    ? "Data only"
                    : t.body === ""
                      ? t.title
                      : `${t.title} — ${t.body}`
                }
              />
            </Table.Td>
            <Table.Td style={NOWRAP}>
              {t.variables.length === 0 ? (
                <Text size="sm" c="dimmed" component="span">
                  none
                </Text>
              ) : (
                <FoldCell
                  label={t.variables.join(", ")}
                  ariaLabel={`${t.variables.join(", ")} — variables of ${t.name}`}
                  what={`Variables of ${t.name}`}
                  width={180}
                  detail={
                    <Text size="sm">
                      <VarCodes names={t.variables} />
                    </Text>
                  }
                  tooltip={t.variables.join(", ")}
                />
              )}
            </Table.Td>
            <Table.Td style={NOWRAP}>{fmtRelative(t.updatedAt)}</Table.Td>
          </>
        )}
        actions={
          owner
            ? (t) => (
                <RowMenu
                  name={t.name}
                  items={[
                    { label: "Edit", onClick: () => open(t) },
                    {
                      label: "Delete",
                      danger: true,
                      disabled: removeAct.busy,
                      onClick: () => remove(t),
                      confirm: {
                        title: `Delete ${t.name}?`,
                        message:
                          "Jobs already submitted keep the text they were submitted with.",
                        confirmLabel: "Delete template",
                        danger: true,
                      },
                    },
                  ]}
                />
              )
            : undefined
        }
      />
      <ResourceDrawer
        opened={drawer.opened}
        onClose={drawer.close}
        title={editing ? "Edit template" : "New template"}
        submitLabel={editing ? "Save" : "Create template"}
        onSubmit={submit}
        busy={act.busy}
        error={drawer.opened ? act.error : null}
        size="lg"
        danger={
          editing
            ? {
                label: "Delete template",
                description:
                  "Jobs already submitted keep the text they were submitted with.",
                onConfirm: () => remove(editing),
                disabled: removeAct.busy,
              }
            : undefined
        }
      >
        <TextInput
          label="Name"
          description="How campaigns and the CLI name it; unique in the channel."
          value={f.name}
          onChange={(e) => {
            setNameError(null);
            drawer.patch({ name: e.currentTarget.value });
          }}
          error={
            nameError ??
            (tried || f.name !== "" ? nameProblem : null) ??
            undefined
          }
          withAsterisk
          data-autofocus
        />
        <MessageFields
          form={f}
          onChange={(m) => drawer.patch(m)}
          problems={problems}
        />
        {problems.message && (tried || f.title !== "" || f.data.length > 0) && (
          <Notice kind="error">{problems.message}</Notice>
        )}
        <MessagePreview
          text={messageText(f)}
          samples={samples}
          onSamples={setSamples}
        />
      </ResourceDrawer>
    </Section>
  );
}
