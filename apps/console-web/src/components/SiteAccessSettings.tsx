import {
  Button,
  Group,
  Modal,
  NativeSelect,
  PasswordInput,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import type { Site } from "../types";
import { useAction } from "../lib/query";
import { ResourceDrawer, useDrawerForm } from "./ResourceDrawer";
import { Section } from "./Section";
import { Badge, Notice } from "./ui";
import { passwordStrength, sitePasswordIssue } from "../lib/password-strength";

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
  const [saved, setSaved] = useState<{
    siteId: string;
    submitted: boolean;
  } | null>(null);
  const showSaved = (result: Site) =>
    setSaved({
      siteId: site.id,
      submitted: result.access?.sync === "submitted",
    });
  const auth = useDrawerForm(() => ({
    mode: site.access?.mode ?? "public",
    username: site.access?.username ?? "",
    password: "",
  }));
  const strength = auth.form.password
    ? passwordStrength(auth.form.password)
    : null;
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
      showSaved(result);
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
              void act
                .run(() => api.siteAccessSync(site.id))
                .then((result) => {
                  reload();
                  if (result) showSaved(result);
                });
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
      <Modal
        opened={saved?.siteId === site.id}
        onClose={() => setSaved(null)}
        closeButtonProps={{ "aria-label": "Close access notice" }}
        title={
          saved?.submitted ? "Access settings saved" : "Synchronization pending"
        }
        zIndex={300}
        centered
      >
        <Text>
          {saved?.submitted
            ? "Changes may take tens of seconds to reach all CDN locations. Until then, the previous access settings may still apply, including an ID/password prompt after switching to Public. Wait briefly, then reload the site."
            : "Settings were saved, but CDN synchronization is still pending. Use Retry synchronization in Access. Once submitted, changes may take tens of seconds to reach all CDN locations."}
        </Text>
        <Group justify="flex-end" mt="md">
          <Button onClick={() => setSaved(null)}>Got it</Button>
        </Group>
      </Modal>
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
            (!auth.form.username ||
              sitePasswordIssue(auth.form.password) !== undefined))
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
              description="At least 4 characters. Strength is guidance only."
              error={
                auth.form.password
                  ? sitePasswordIssue(auth.form.password)
                  : undefined
              }
              autoComplete="new-password"
              value={auth.form.password}
              onChange={(e) => {
                const value = e.currentTarget.value;
                auth.setForm((f) => ({ ...f, password: value }));
              }}
            />
            <div role="status" aria-live="polite" aria-atomic="true">
              {strength && (
                <>
                  <Text component="span" size="sm">
                    Password strength:{" "}
                  </Text>
                  <Badge
                    tone={
                      strength === "Too easy"
                        ? "danger"
                        : strength === "Medium"
                          ? "warn"
                          : "ok"
                    }
                  >
                    {strength}
                  </Badge>
                </>
              )}
            </div>
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
            showSaved(result);
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
