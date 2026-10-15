import {
  Button,
  Group,
  NativeSelect,
  PasswordInput,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import type { FormEvent } from "react";
import { api } from "../api";
import type { Site } from "../types";
import { useAction } from "../lib/query";
import { notify } from "../lib/notify";
import { ResourceDrawer, useDrawerForm } from "./ResourceDrawer";
import { Section } from "./Section";
import { Notice } from "./ui";

export function SiteAccessSettings({
  site,
  approved,
  approvalPending = false,
  requestApproval,
  writable,
  admin,
  reload,
}: {
  site: Site;
  approved: boolean;
  approvalPending?: boolean;
  requestApproval?: () => void;
  writable: boolean;
  admin: boolean;
  reload: () => void;
}) {
  const act = useAction();
  const auth = useDrawerForm(() => ({
    mode: site.access?.mode ?? "public",
    username: site.access?.username ?? "",
    password: "",
  }));
  const stop = useDrawerForm(() => ({ reason: "" }));
  const access = site.access;
  if (!access) return null;
  const canEdit =
    approved && access.available && !access.suspended && !site.busy;
  const closeAuth = () => {
    auth.setForm({ mode: "public", username: "", password: "" });
    auth.close();
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!canEdit) return;
    const result = await act.run(() =>
      api.siteAuth(
        site.id,
        auth.form.mode === "public"
          ? { mode: "public" }
          : {
              mode: "basic",
              username: auth.form.username,
              password: auth.form.password,
            },
      ),
    );
    // Passwords live only in this form, including failed submissions.
    auth.setForm((f) => ({ ...f, password: "" }));
    reload();
    if (result) {
      closeAuth();
      notify.saved("Access settings");
    }
  };
  return (
    <Section title="Access">
      <Text>
        {access.suspended
          ? "Access suspended by platform admin"
          : access.mode === "basic"
            ? "Basic Auth configured"
            : "Public"}
      </Text>
      <Text size="sm" c="dimmed">
        {approved
          ? "Basic Auth approved for this site."
          : approvalPending
            ? "Basic Auth approval is pending."
            : "Request Basic Auth approval here before configuring access."}{" "}
        Changes propagate across the CDN; saved settings do not mean every edge
        has updated. Previously downloaded files cannot be recalled.
      </Text>
      {access.sync === "pending" && (
        <Notice kind="error">
          Access policy synchronization is pending. Retry synchronization before
          relying on the new settings.
        </Notice>
      )}
      <Group mt="sm">
        {writable &&
          (approved ? (
            <Button variant="default" disabled={!canEdit} onClick={auth.open}>
              Edit access
            </Button>
          ) : (
            <Button
              variant="default"
              disabled={
                approvalPending ||
                !requestApproval ||
                !access.available ||
                access.suspended ||
                site.busy
              }
              onClick={requestApproval}
            >
              {approvalPending ? "Approval pending" : "Request Basic Auth"}
            </Button>
          ))}
        {(writable || admin) && access.sync === "pending" && (
          <Button
            variant="default"
            loading={act.busy}
            onClick={() => {
              void act.run(() => api.siteAccessSync(site.id)).then(reload);
            }}
          >
            Retry synchronization
          </Button>
        )}
        {admin && (
          <Button variant="default" onClick={stop.open}>
            {access.suspended ? "Resume access" : "Suspend access"}
          </Button>
        )}
      </Group>
      {!auth.opened && !stop.opened && act.error && (
        <Notice kind="error">{act.error}</Notice>
      )}
      <ResourceDrawer
        opened={auth.opened && canEdit}
        onClose={closeAuth}
        title="Edit site access"
        submitLabel={
          auth.form.mode === "public" ? "Make public" : "Save Basic Auth"
        }
        onSubmit={save}
        busy={act.busy}
        error={auth.opened ? act.error : null}
        disabled={
          !canEdit ||
          (auth.form.mode === "basic" &&
            (!auth.form.username || auth.form.password.length < 16))
        }
      >
        <NativeSelect
          label="Access mode"
          value={auth.form.mode}
          data={[
            { value: "public", label: "Public — anyone can view" },
            { value: "basic", label: "Basic Auth — approved sites only" },
          ]}
          onChange={(e) => {
            const value = e.currentTarget.value as "public" | "basic";
            auth.setForm((f) => ({ ...f, mode: value }));
          }}
        />
        {auth.form.mode === "basic" ? (
          <>
            <TextInput
              label="ID"
              autoComplete="off"
              maxLength={64}
              value={auth.form.username}
              onChange={(e) => {
                const value = e.currentTarget.value;
                auth.setForm((f) => ({ ...f, username: value }));
              }}
            />
            <PasswordInput
              label="New password"
              description="16–128 printable ASCII characters. Use a unique, randomly generated password."
              autoComplete="new-password"
              value={auth.form.password}
              onChange={(e) => {
                const value = e.currentTarget.value;
                auth.setForm((f) => ({ ...f, password: value }));
              }}
            />
            <Text size="sm">
              Only the independent site host will work. The shared path URL will
              be blocked; use a relative build base.
            </Text>
          </>
        ) : (
          <Text>
            Saving makes this site's files accessible without credentials.
          </Text>
        )}
      </ResourceDrawer>
      <ResourceDrawer
        opened={stop.opened}
        onClose={stop.close}
        title={access.suspended ? "Resume site access" : "Suspend site access"}
        submitLabel={access.suspended ? "Resume access" : "Suspend access"}
        busy={act.busy}
        error={stop.opened ? act.error : null}
        disabled={!stop.form.reason.trim()}
        onSubmit={async (e) => {
          e.preventDefault();
          const result = await act.run(() =>
            api.siteSuspension(site.id, !access.suspended, stop.form.reason),
          );
          reload();
          if (result) {
            stop.close();
            notify.saved("Access settings");
          }
        }}
      >
        <Text>
          Both site addresses are affected. Approval and credentials are
          preserved. Resuming restores the previous access mode.
        </Text>
        <Textarea
          label="Reason"
          maxLength={500}
          value={stop.form.reason}
          onChange={(e) => stop.setForm({ reason: e.currentTarget.value })}
        />
      </ResourceDrawer>
    </Section>
  );
}
