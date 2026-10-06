import {
  Anchor,
  Box,
  Button,
  Code,
  Divider,
  Group,
  NativeSelect,
  Stack,
  Table,
  Text,
  VisuallyHidden,
} from "@mantine/core";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import { useConfirm } from "../lib/confirm";
import { useCursorList } from "../lib/cursor";
import { fmtRelative, fmtTime } from "../lib/format";
import { fmtBytes } from "../lib/limits";
import { notify } from "../lib/notify";
import { openDownload } from "../lib/push";
import {
  CANCEL_MISSED,
  INVALID_ROWS_HINT,
  broadcastTemplates,
  campaignProblem,
  cancelMissed,
  checkCsvFile,
  createKeyRing,
  emptyMessage,
  emptyOptions,
  hasProblems,
  jobActive,
  jobCountLines,
  jobErrorSentence,
  jobKindLabel,
  jobOptions,
  jobProgress,
  jobStatus,
  jobSummary,
  messageProblems,
  messageText,
  optionsProblems,
  reportBlock,
  templateVars,
  type CampaignProblem,
  type CsvCheck,
} from "../lib/pushCampaign";
import { useAction, useApiQuery } from "../lib/query";
import type {
  Channel,
  PushJob,
  PushJobPage,
  PushTemplate,
  PushUploadGrant,
} from "../types";
import { Clipped } from "./Clipped";
import { DataTable } from "./DataTable";
import { FilePicker } from "./FilePicker";
import {
  AdvancedOptions,
  DrawerFoot,
  MessageBox,
  MessageFields,
  VarCodes,
} from "./PushMessageFields";
import { PushTemplatesSection } from "./PushTemplates";
import { ResourceDrawer } from "./ResourceDrawer";
import { Section } from "./Section";
import { Badge, CopyField, Notice } from "./ui";

/*
 * Campaigns and the broadcast of a push channel (`docs/push.md`
 * *Campaigns*): templates, the job list with its submit drawer (dry run
 * first), a job's details with cancel and report, and the broadcast as a
 * separate verb. Nothing here shows or holds a device token: the API
 * returns none.
 */

const NOWRAP = { whiteSpace: "nowrap" } as const;
/** How often unfinished jobs are re-read while the tab is visible. */
export const PUSH_JOB_POLL_MS = 5000;
/** Jobs one tick re-reads: the newest unfinished ones. */
const POLL_MAX = 5;

/** `fn` every `ms` while `on` and the tab is visible; no timer otherwise. */
function useVisiblePoll(on: boolean, fn: () => Promise<void>, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!on) return;
    let timer: number | undefined;
    let running = false;
    const tick = () => {
      if (running) return;
      running = true;
      void ref.current().finally(() => (running = false));
    };
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const sync = () => {
      if (document.hidden) stop();
      else timer ??= window.setInterval(tick, ms);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", sync);
    };
  }, [on, ms]);
}

/**
 * The channel's jobs, newest first: the paged list, plus the jobs a submit,
 * a cancel or a poll answered since (`fresh`), which replace their row.
 * Unfinished jobs are re-read one by one — the status read is also what
 * kicks a job whose worker died.
 */
function usePushJobs(channelId: string) {
  const list = useCursorList<PushJobPage, PushJob>(
    ["channel", channelId, "push", "jobs"],
    (cursor) => api.pushJobs(channelId, cursor),
    (p) => p.jobs,
  );
  const [fresh, setFresh] = useState<Record<string, PushJob>>({});
  const rows = list.rows?.map((j) => fresh[j.id] ?? j);
  const listed = new Set(rows?.map((j) => j.id));
  const known = [
    ...Object.values(fresh).filter((j) => !listed.has(j.id)),
    ...(rows ?? []),
  ];
  const active = known.filter(jobActive).slice(0, POLL_MAX);
  const put = (j: PushJob) => setFresh((cur) => ({ ...cur, [j.id]: j }));
  useVisiblePoll(
    active.length > 0,
    async () => {
      const read = await Promise.all(
        active.map((j) => api.pushJob(channelId, j.id).catch(() => null)),
      );
      setFresh((cur) => {
        const next = { ...cur };
        for (const j of read) if (j) next[j.id] = j;
        return next;
      });
    },
    PUSH_JOB_POLL_MS,
  );
  return {
    rows,
    next: list.next,
    loading: list.loading,
    error: list.error,
    busy: list.busy,
    fetching: list.fetching,
    loadMore: list.loadMore,
    reload: list.reload,
    put,
    byId: (id: string | null) =>
      id === null ? undefined : known.find((j) => j.id === id),
  };
}
type Jobs = ReturnType<typeof usePushJobs>;

/** The upload of one picked file, and what became of it. */
interface FormUpload {
  file: File;
  grant: PushUploadGrant;
  put: boolean;
  /**
   * A job names it, or may: a submit answered with a job, or ended without
   * an answer that says none was recorded (no answer at all, a 5xx).
   */
  used: boolean;
}

/**
 * Deletes an upload the form made and no job used, so it stops holding one
 * of the channel's pending places. Best effort: the route takes the write
 * slot (429), and the platform removes an unused upload after two days.
 */
function discardUpload(channelId: string, u: FormUpload | null): void {
  if (!u || u.used) return;
  void (async () => {
    try {
      await api.deletePushUpload(channelId, u.grant.uploadId);
    } catch {
      // Left to the platform's own cleanup.
    }
  })();
}

/** A submit's failure that says no job was recorded: a 4xx answer. */
const refused = (e: unknown): boolean => {
  const status = (e as { status?: unknown }).status;
  return typeof status === "number" && status >= 400 && status < 500;
};

/** The Limits section of the same page takes the request. */
function toLimits() {
  document.getElementById("limits")?.scrollIntoView({ behavior: "smooth" });
}

/** A refusal where the form shows it; `at: "file" | "template"` go to their field. */
function ProblemNotice({
  problem,
  onLimits,
}: {
  problem: CampaignProblem | null;
  onLimits: () => void;
}) {
  if (!problem || problem.at === "file" || problem.at === "template")
    return null;
  return (
    <Notice kind="error">
      {problem.message}
      {problem.at === "limit" && (
        <>
          {" "}
          <Anchor component="button" type="button" size="sm" onClick={onLimits}>
            Ask for more under Limits
          </Anchor>{" "}
          (Request increase → Jobs per day).
        </>
      )}
    </Notice>
  );
}

function Facts({ lines }: { lines: [string, string][] }) {
  return (
    <Stack gap={2}>
      {lines.map(([label, value]) => (
        <Group key={label} gap="xs" justify="space-between" wrap="nowrap">
          <Text size="sm" c="dimmed">
            {label}
          </Text>
          <Text size="sm" style={{ fontVariantNumeric: "tabular-nums" }}>
            {value}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}

function StatusBadge({ job }: { job: PushJob }) {
  const s = jobStatus(job);
  // A badge ellipses its own label before a table column widens
  // (`rules/ui.md`): the wrapper holds it at its full width.
  return (
    <Box
      component="span"
      style={{ display: "inline-block", minWidth: "max-content" }}
    >
      <Badge tone={s.tone}>{s.label}</Badge>
    </Box>
  );
}

/* ------------------------------------------------------------------ */
/* campaign submit                                                     */
/* ------------------------------------------------------------------ */

/** What a dry run found, in the drawer that asked for it. */
function DryRunResult({ job }: { job: PushJob }) {
  const error = jobErrorSentence(job);
  return (
    <Stack
      gap="xs"
      role="group"
      aria-label="Dry run result"
      p="sm"
      style={{
        border: "1px solid var(--yyt-hairline)",
        borderRadius: "var(--mantine-radius-md)",
      }}
    >
      <Text size="sm" fw={500} component="div">
        Dry run <StatusBadge job={job} />
      </Text>
      {jobActive(job) ? (
        <Text size="sm" c="dimmed">
          Counting the file: {jobProgress(job)} rows. Nothing is sent.
        </Text>
      ) : error ? (
        <Text size="sm" c="red" role="alert">
          {error}
        </Text>
      ) : (
        <>
          <Facts lines={jobCountLines(job)} />
          <Text size="xs" c="dimmed">
            Nothing was sent. The job&rsquo;s report lists every row.
          </Text>
        </>
      )}
    </Stack>
  );
}

function CampaignForm({
  channel,
  templates,
  jobs,
  onClose,
  onCounted,
}: {
  channel: Channel;
  templates: PushTemplate[];
  jobs: Jobs;
  onClose: () => void;
  onCounted: () => void;
}) {
  const confirm = useConfirm();
  const [templateId, setTemplateId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [check, setCheck] = useState<CsvCheck | null>(null);
  const [options, setOptions] = useState(emptyOptions);
  const [busy, setBusy] = useState<"dry" | "send" | null>(null);
  const [problem, setProblem] = useState<CampaignProblem | null>(null);
  const [dryJobId, setDryJobId] = useState<string | null>(null);
  // One key per distinct submit, for as long as the form lives: a retry of
  // the same submit is replayed by the server, never recorded twice.
  const keyOf = useRef(createKeyRing()).current;
  // The upload of the picked file; the dry run and the job share it.
  const upload = useRef<FormUpload | null>(null);
  // The drawer closed: an upload no job used is deleted again.
  useEffect(
    () => () => discardUpload(channel.id, upload.current),
    [channel.id],
  );

  const template = templates.find((t) => t.id === templateId);
  const variables = template?.variables.join(",") ?? "";
  useEffect(() => {
    let stale = false;
    setCheck(null);
    if (file && template)
      void checkCsvFile(file, template.variables)
        .catch((): CsvCheck => ({
          ok: false,
          problem: "The file cannot be read.",
        }))
        .then((c) => !stale && setCheck(c));
    return () => {
      stale = true;
    };
    // `variables` stands for the template: its text does not matter here.
  }, [file, templateId, variables]);

  const optProblems = optionsProblems(options);
  const ready =
    !!template && !!file && check?.ok === true && !hasProblems(optProblems);

  const ensureUpload = async (f: File): Promise<string> => {
    let u = upload.current;
    // A grant's URL works for 15 minutes; a new one holds another of the
    // channel's pending places, so the one it replaces is given back.
    if (
      u?.file !== f ||
      (!u.put && Date.now() / 1000 > u.grant.expiresAt - 30)
    ) {
      discardUpload(channel.id, u);
      upload.current = null;
      u = upload.current = {
        file: f,
        grant: await api.createPushUpload(channel.id, f.size),
        put: false,
        used: false,
      };
    }
    if (!u.put) {
      await api.putPushUpload(u.grant, f);
      u.put = true;
    }
    return u.grant.uploadId;
  };

  const submit = async (dryRun: boolean) => {
    if (!template || !file || !ready || busy) return;
    if (!dryRun) {
      const ok = await confirm({
        title: `Send ${template.name} to the users in ${file.name}?`,
        message:
          "Every user of the file who holds a device token gets the message. It cannot be recalled, and it counts as one of today's jobs.",
        confirmLabel: "Send campaign",
      });
      if (!ok.ok) return;
    }
    setBusy(dryRun ? "dry" : "send");
    setProblem(null);
    try {
      const params = {
        templateId: template.id,
        uploadId: await ensureUpload(file),
        ...(dryRun ? { dryRun: true } : {}),
        ...jobOptions(options),
      };
      const sent = upload.current;
      let r;
      try {
        r = await api.submitPushJob(channel.id, {
          ...params,
          idempotencyKey: keyOf(params),
        });
      } catch (e) {
        // Without a refusal the job may exist and read the upload.
        if (sent && !refused(e)) sent.used = true;
        throw e;
      }
      if (sent) sent.used = true;
      jobs.put(r.job);
      void jobs.reload();
      if (dryRun) return setDryJobId(r.job.id);
      notify.done(r.created ? "Campaign queued" : "Campaign already queued");
      onCounted();
      onClose();
    } catch (e) {
      const p = campaignProblem(e, "job");
      // The stored object is not usable: the next submit uploads anew.
      if (p.at === "file" && p.reupload) {
        discardUpload(channel.id, upload.current);
        upload.current = null;
      }
      setProblem(p);
    } finally {
      setBusy(null);
    }
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(false);
  };
  const dryJob = jobs.byId(dryJobId);
  const fileProblem =
    check?.ok === false
      ? check.problem
      : problem?.at === "file"
        ? problem.message
        : null;

  return (
    <form onSubmit={onSubmit}>
      <Stack gap="md">
        {templates.length === 0 && (
          <Notice>Write a template first: a campaign sends one.</Notice>
        )}
        <NativeSelect
          label="Template"
          value={templateId}
          data={[
            { value: "", label: "Pick a template", disabled: true },
            ...templates.map((t) => ({ value: t.id, label: t.name })),
          ]}
          onChange={(e) => {
            setTemplateId(e.currentTarget.value);
            setDryJobId(null);
            setProblem(null);
          }}
          error={problem?.at === "template" ? problem.message : undefined}
        />
        {template && <MessageBox message={template} label="Message" />}
        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Recipients
          </Text>
          <Text size="xs" c="dimmed">
            A UTF-8 CSV whose first line names its columns: <Code>userId</Code>
            {template && template.variables.length > 0 && (
              <>
                {" "}
                and <VarCodes names={template.variables} />
              </>
            )}
            . Users are named by id only; a device token never belongs in the
            file.
          </Text>
          <Group gap="xs" wrap="wrap">
            <FilePicker
              label="Choose CSV file"
              accept=".csv,text/csv"
              disabled={busy !== null}
              onPick={([picked]) => {
                setFile(picked ?? null);
                setDryJobId(null);
                setProblem(null);
              }}
            />
            {file && (
              <Text size="sm" style={{ overflowWrap: "anywhere" }}>
                {file.name} · {fmtBytes(file.size)}
              </Text>
            )}
          </Group>
          {check?.ok && (
            <Text size="xs" c="dimmed">
              Columns: {check.columns.join(", ")}
            </Text>
          )}
          {fileProblem && (
            <Text size="sm" c="red" role="alert">
              {fileProblem}
            </Text>
          )}
        </Stack>
        <AdvancedOptions
          form={options}
          onChange={setOptions}
          problems={optProblems}
        />
        {dryJob && <DryRunResult job={dryJob} />}
        <ProblemNotice
          problem={problem}
          onLimits={() => {
            onClose();
            toLimits();
          }}
        />
        <DrawerFoot
          submitLabel="Send campaign"
          busy={busy === "send"}
          disabled={!ready || busy !== null}
          onCancel={onClose}
          before={
            <Button
              variant="default"
              disabled={!ready || busy !== null}
              loading={busy === "dry"}
              onClick={() => void submit(true)}
            >
              Dry run
            </Button>
          }
        />
      </Stack>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* job details                                                         */
/* ------------------------------------------------------------------ */

function JobDetails({
  job,
  channel,
  owner,
  jobs,
}: {
  job: PushJob;
  channel: Channel;
  owner: boolean;
  jobs: Jobs;
}) {
  const { me } = useAuth();
  const confirm = useConfirm();
  const cancelAct = useAction();
  const reportAct = useAction();
  const error = jobErrorSentence(job);
  const blocked = reportBlock(job, owner);
  const o = job.options;
  const cancel = async () => {
    const ok = await confirm({
      title: "Cancel this job?",
      message:
        "The job ends between two batches. Rows already sent stay sent and are in the report.",
      confirmLabel: "Cancel job",
      cancelLabel: "Keep it running",
      danger: true,
    });
    if (!ok.ok) return;
    const r = await cancelAct.run(async () => {
      try {
        return await api.cancelPushJob(channel.id, job.id);
      } catch (e) {
        throw new Error(campaignProblem(e, "cancel").message);
      }
    });
    if (!r) return;
    jobs.put(r);
    // Not an error: the last batch was already running.
    notify.done(
      cancelMissed(r)
        ? "The job finished before the cancel took effect"
        : "Cancel requested",
    );
  };
  const download = async () => {
    const r = await reportAct.run(async () => {
      try {
        return await api.pushJobReport(channel.id, job.id);
      } catch (e) {
        throw new Error(campaignProblem(e, "report").message);
      }
    });
    if (r) openDownload(r.url);
  };
  return (
    <>
      <Text size="sm" component="div">
        <StatusBadge job={job} /> {jobKindLabel(job)} · submitted{" "}
        {fmtTime(job.createdAt)} by {authorLabel(job.author, me)}
      </Text>
      {error && (
        <Notice kind={job.error === "canceled" ? "info" : "error"}>
          {error}
        </Notice>
      )}
      {cancelMissed(job) && <Notice>{CANCEL_MISSED}</Notice>}
      <Box>
        <CopyField label="Job id" value={job.id} />
        <CopyField label="Idempotency key" value={job.idempotencyKey} />
      </Box>
      <Facts
        lines={[
          ...(job.kind === "campaign"
            ? ([["Progress (rows)", jobProgress(job)]] as [string, string][])
            : []),
          ...jobCountLines(job),
          ["Started", fmtTime(job.startedAt)],
          ["Finished", fmtTime(job.finishedAt)],
          ...(o.priority
            ? ([["Priority", o.priority]] as [string, string][])
            : []),
          ...(o.ttlSec !== undefined
            ? ([["Time to live", `${o.ttlSec} s`]] as [string, string][])
            : []),
          ...(o.collapseKey
            ? ([["Collapse key", o.collapseKey]] as [string, string][])
            : []),
        ]}
      />
      {job.kind === "campaign" && (
        <Text size="xs" c="dimmed">
          Counts are per row (user), not per device. {INVALID_ROWS_HINT}
        </Text>
      )}
      <MessageBox message={job.message} label="Message as submitted" />
      {reportAct.error && <Notice kind="error">{reportAct.error}</Notice>}
      <Group gap="sm" align="center">
        <Button
          variant="default"
          disabled={blocked !== null || reportAct.busy}
          loading={reportAct.busy}
          onClick={() => void download()}
        >
          Download report
        </Button>
        <Text size="sm" c="dimmed" style={{ flex: 1, minWidth: 180 }}>
          {blocked ??
            `One line per CSV row (userId, status, reason), until ${fmtTime(job.report?.expiresAt)}.`}
        </Text>
      </Group>
      {owner && jobActive(job) && (
        <Box mt="md">
          <Divider mb="md" />
          {cancelAct.error && <Notice kind="error">{cancelAct.error}</Notice>}
          <Button
            color="red"
            variant="outline"
            disabled={job.cancelRequested || cancelAct.busy}
            onClick={() => void cancel()}
          >
            Cancel job
          </Button>
          {job.cancelRequested && (
            <Text size="sm" c="dimmed" mt="xs">
              Cancel requested: the job ends after its current batch.
            </Text>
          )}
        </Box>
      )}
    </>
  );
}

/** A job names its author by member id only (or `apikey`). */
function authorLabel(author: string, me: { id: string; login: string } | null) {
  if (author === "apikey") return "API key";
  return me && author === me.id ? me.login : author;
}

/* ------------------------------------------------------------------ */
/* broadcast                                                           */
/* ------------------------------------------------------------------ */

/** `docs/push.md` *Broadcast*: a topic is not private. */
const BROADCAST_PUBLIC =
  "A broadcast is not confidential: anyone who holds the app can subscribe to the topic. Put no secret, no personal data and nothing that grants something (a code, a reward) in it; send private content with a campaign.";

function BroadcastForm({
  channel,
  templates,
  jobs,
  onClose,
  onCounted,
}: {
  channel: Channel;
  templates: PushTemplate[];
  jobs: Jobs;
  onClose: () => void;
  onCounted: () => void;
}) {
  const confirm = useConfirm();
  const [templateId, setTemplateId] = useState("");
  const [message, setMessage] = useState(emptyMessage);
  const [options, setOptions] = useState(emptyOptions);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<CampaignProblem | null>(null);
  const keyOf = useRef(createKeyRing()).current;

  const usable = broadcastTemplates(templates);
  const template = usable.find((t) => t.id === templateId);
  const text = messageText(message);
  const problems = template ? {} : messageProblems(message);
  const hasVars = !template && templateVars(text).length > 0;
  const optProblems = optionsProblems(options);
  const topic = channel.topic ?? `yyt.push.${channel.id}`;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (busy || hasVars || hasProblems(problems) || hasProblems(optProblems))
      return;
    const ok = await confirm({
      title: "Send to everyone subscribed?",
      message: (
        <>
          This reaches every device subscribed to the channel topic{" "}
          <Code>{topic}</Code>, at once, and cannot be recalled. It counts as
          one job today (Jobs per day). {BROADCAST_PUBLIC}
        </>
      ),
      confirmLabel: "Send broadcast",
    });
    if (!ok.ok) return;
    setBusy(true);
    setProblem(null);
    try {
      const params = {
        ...(template ? { templateId: template.id } : text),
        ...jobOptions(options),
      };
      const r = await api.pushBroadcast(channel.id, {
        ...params,
        idempotencyKey: keyOf(params),
      });
      jobs.put(r.job);
      void jobs.reload();
      notify.done(r.created ? "Broadcast queued" : "Broadcast already queued");
      onCounted();
      onClose();
    } catch (err) {
      setProblem(campaignProblem(err, "broadcast"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          One message to the topic <Code>{topic}</Code>: every app install that
          subscribed to it, whoever is signed in. No CSV, no per-user text, no
          dry run and no report.
        </Text>
        <Notice kind="warn">{BROADCAST_PUBLIC}</Notice>
        <NativeSelect
          label="Message"
          value={templateId}
          data={[
            { value: "", label: "Write it here" },
            ...templates.map((t) => ({
              value: t.id,
              label:
                t.variables.length > 0
                  ? `${t.name} (has variables)`
                  : `Template: ${t.name}`,
              disabled: t.variables.length > 0,
            })),
          ]}
          onChange={(e) => {
            setTemplateId(e.currentTarget.value);
            setProblem(null);
          }}
          error={problem?.at === "template" ? problem.message : undefined}
        />
        {template ? (
          <MessageBox message={template} label="Message" />
        ) : (
          <>
            <MessageFields
              form={message}
              onChange={setMessage}
              problems={problems}
              variables={false}
            />
            {hasVars ? (
              <Notice kind="error">
                A broadcast cannot hold {"{{variables}}"}: there is no row to
                fill them from.
              </Notice>
            ) : (
              problems.message &&
              tried && <Notice kind="error">{problems.message}</Notice>
            )}
          </>
        )}
        <AdvancedOptions
          form={options}
          onChange={setOptions}
          problems={optProblems}
        />
        <ProblemNotice
          problem={problem}
          onLimits={() => {
            onClose();
            toLimits();
          }}
        />
        <DrawerFoot
          submitLabel="Send to everyone subscribed"
          busy={busy}
          disabled={hasVars}
          onCancel={onClose}
        />
      </Stack>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* sections                                                            */
/* ------------------------------------------------------------------ */

/** Templates, campaigns and the broadcast of one push channel. */
export function PushCampaigns({
  channel,
  owner,
  onCounted,
}: {
  channel: Channel;
  /** A seated team member: writes, and downloads reports. */
  owner: boolean;
  /** A job was recorded: today's `push.jobsPerDay` usage moved. */
  onCounted: () => void;
}) {
  const { me } = useAuth();
  const templates = useApiQuery(
    ["channel", channel.id, "push", "templates"],
    () => api.pushTemplates(channel.id),
  );
  const jobs = usePushJobs(channel.id);
  // A form is mounted per opening: its state, upload and idempotency keys
  // never outlive the drawer.
  const [form, setForm] = useState<{
    kind: "campaign" | "broadcast";
    n: number;
  } | null>(null);
  const [opens, setOpens] = useState(0);
  const openForm = (kind: "campaign" | "broadcast") => {
    setOpens((n) => n + 1);
    setForm({ kind, n: opens + 1 });
  };
  const closeForm = () => setForm(null);
  const [viewingId, setViewingId] = useState<string | null>(null);
  const viewing = jobs.byId(viewingId);
  const list = templates.data?.templates ?? [];
  const topic = channel.topic ?? `yyt.push.${channel.id}`;

  return (
    <>
      <PushTemplatesSection
        channelId={channel.id}
        owner={owner}
        templates={templates}
      />
      <Section
        title="Campaigns"
        description="A campaign sends a template to the users a CSV lists. A dry run counts what the file would do and sends nothing."
        actions={
          owner && (
            <Button variant="default" onClick={() => openForm("campaign")}>
              New campaign
            </Button>
          )
        }
      >
        <DataTable
          columns={[
            { key: "status", label: "Status" },
            { key: "kind", label: "Kind" },
            { key: "progress", label: "Rows done", align: "right" },
            { key: "result", label: "Result" },
            { key: "author", label: "Author" },
            { key: "at", label: "Submitted" },
            { key: "open", label: <VisuallyHidden>Open</VisuallyHidden> },
          ]}
          rows={jobs.rows}
          loading={jobs.loading}
          error={jobs.error}
          rowKey={(j) => j.id}
          minWidth={720}
          empty={{
            title: "No jobs yet.",
            hint: "Jobs are listed here for 30 days after they finished.",
          }}
          render={(j) => (
            <>
              <Table.Td style={NOWRAP}>
                <StatusBadge job={j} />
              </Table.Td>
              <Table.Td style={NOWRAP}>{jobKindLabel(j)}</Table.Td>
              <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
                {j.kind === "broadcast" ? "—" : jobProgress(j)}
              </Table.Td>
              <Table.Td style={NOWRAP}>{jobSummary(j)}</Table.Td>
              <Table.Td style={NOWRAP}>
                {j.author === "apikey" || j.author === me?.id ? (
                  authorLabel(j.author, me)
                ) : (
                  <Clipped text={j.author} width={110} what="Full member id" />
                )}
              </Table.Td>
              <Table.Td style={NOWRAP}>{fmtRelative(j.createdAt)}</Table.Td>
              <Table.Td style={{ ...NOWRAP, textAlign: "right" }}>
                <Button
                  variant="default"
                  size="compact-sm"
                  aria-label={`Details of ${j.id}`}
                  onClick={() => setViewingId(j.id)}
                >
                  Details
                </Button>
              </Table.Td>
            </>
          )}
        />
        {jobs.next && (
          <Group justify="center" mt="sm">
            <Button
              variant="default"
              size="compact-sm"
              loading={jobs.busy}
              disabled={jobs.fetching}
              onClick={() => void jobs.loadMore()}
            >
              Load more
            </Button>
          </Group>
        )}
      </Section>
      <Section
        title="Broadcast"
        description="One message to every device subscribed to the channel topic, whatever the audience: no CSV and no per-user text."
        actions={
          owner && (
            <Button variant="default" onClick={() => openForm("broadcast")}>
              Send to everyone subscribed
            </Button>
          )
        }
      >
        <Text size="sm" c="dimmed">
          Topic <Code>{topic}</Code>. A device receives a broadcast only if its
          app subscribed to the topic; the platform keeps no subscriber list. A
          broadcast is listed under Campaigns and counts as one job of the day.
        </Text>
        <Text size="sm" c="dimmed" mt="xs">
          {BROADCAST_PUBLIC}
        </Text>
      </Section>

      <ResourceDrawer
        opened={form?.kind === "campaign"}
        onClose={closeForm}
        title="New campaign"
        size="lg"
        plain
      >
        {form?.kind === "campaign" && (
          <CampaignForm
            key={form.n}
            channel={channel}
            templates={list}
            jobs={jobs}
            onClose={closeForm}
            onCounted={onCounted}
          />
        )}
      </ResourceDrawer>
      <ResourceDrawer
        opened={form?.kind === "broadcast"}
        onClose={closeForm}
        title="Broadcast"
        size="lg"
        plain
      >
        {form?.kind === "broadcast" && (
          <BroadcastForm
            key={form.n}
            channel={channel}
            templates={list}
            jobs={jobs}
            onClose={closeForm}
            onCounted={onCounted}
          />
        )}
      </ResourceDrawer>
      <ResourceDrawer
        opened={viewing !== undefined}
        onClose={() => setViewingId(null)}
        title="Job"
        size="lg"
        hideFooter
      >
        {viewing && (
          <JobDetails
            job={viewing}
            channel={channel}
            owner={owner}
            jobs={jobs}
          />
        )}
      </ResourceDrawer>
    </>
  );
}
