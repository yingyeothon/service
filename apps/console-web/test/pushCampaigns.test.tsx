import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type * as PushLib from "../src/lib/push";
import type {
  Channel,
  LimitRow,
  PushJob,
  PushTemplate,
  PushUploadGrant,
} from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  channel: vi.fn(),
  team: vi.fn(),
  projectChannels: vi.fn(),
  limits: vi.fn(),
  requestLimit: vi.fn(),
  pushTemplates: vi.fn(),
  createPushTemplate: vi.fn(),
  updatePushTemplate: vi.fn(),
  deletePushTemplate: vi.fn(),
  createPushUpload: vi.fn(),
  deletePushUpload: vi.fn(),
  putPushUpload: vi.fn(),
  submitPushJob: vi.fn(),
  pushBroadcast: vi.fn(),
  pushJobs: vi.fn(),
  pushJob: vi.fn(),
  cancelPushJob: vi.fn(),
  pushJobReport: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const openDownload = vi.fn();
vi.mock("../src/lib/push", async (orig) => ({
  ...(await orig<typeof PushLib>()),
  openDownload,
}));

const { ChannelDetailPage } = await import("../src/pages/ChannelDetail");
const { PUSH_JOB_POLL_MS } = await import("../src/components/PushCampaigns");
const { mount: mountWith } = await import("./wrap");

const CHANNEL: Channel = {
  id: "push_9",
  kind: "push",
  name: "alerts",
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "game",
  createdBy: "alice",
  config: {
    authChannelId: "auth_1",
    packageName: "com.example.game",
    sender: "platform",
  },
  createdAt: 0,
  expiresAt: 0,
  disabledAt: null,
  status: "active",
  registered: true,
  apiBase: "https://state.example.test",
  topic: "yyt.push.push_9",
};

const template = (p: Partial<PushTemplate> = {}): PushTemplate => ({
  id: "pt_1",
  channelId: "push_9",
  name: "welcome",
  title: "Hi {{name}}",
  body: "You scored {{score}}",
  data: { screen: "home" },
  variables: ["name", "score"],
  createdBy: "m_1",
  createdByLogin: "alice",
  updatedBy: "m_2",
  updatedByLogin: "bob",
  createdAt: 1_790_000_000,
  updatedAt: 1_790_000_100,
  ...p,
});
const NOTICE = template({
  id: "pt_2",
  name: "maintenance",
  title: "Maintenance at noon",
  body: "",
  data: {},
  variables: [],
});

const job = (p: Partial<PushJob> = {}): PushJob => ({
  id: "pj_1",
  channelId: "push_9",
  kind: "campaign",
  dryRun: false,
  status: "done",
  error: null,
  errorDetails: null,
  cancelRequested: false,
  idempotencyKey: "launch-1",
  templateId: "pt_1",
  uploadId: "pu_1",
  message: { title: "Hi {{name}}", body: "", data: {} },
  options: {},
  author: "m_1",
  total: 1200,
  processed: 1200,
  counts: {
    resolved: 1180,
    sent: 1170,
    noToken: 15,
    unregistered: 4,
    failed: 6,
    skipped: 5,
    duplicates: 3,
    missingVariables: 2,
    invalid: 0,
  },
  report: { available: true, expiresAt: 1_790_600_000 },
  createdAt: 1_790_000_000,
  startedAt: 1_790_000_002,
  finishedAt: 1_790_000_060,
  ...p,
});

const GRANT: PushUploadGrant = {
  uploadId: "pu_7",
  url: "https://bucket.example.test/put",
  method: "PUT",
  headers: { "content-type": "text/csv", "content-length": "26" },
  expiresAt: Date.now() / 1000 + 900,
  usableUntil: Date.now() / 1000 + 86400,
  maxBytes: 102_401_024,
};

const limitRow = (key: string, p: Partial<LimitRow>): LimitRow => ({
  key,
  unit: "count",
  soft: 10,
  hard: 100,
  effective: 10,
  usage: null,
  step: null,
  next: null,
  override: null,
  ...p,
});

const refusal = (status: number, details?: unknown, message = "refused") =>
  Object.assign(new Error(message), { status, details });
const csv = (text: string, name = "recipients.csv") =>
  new File([text], name, { type: "text/csv" });
const GOOD_CSV = "userId,name,score\nu1,Al,3\n";

function mount() {
  return mountWith(
    <Routes>
      <Route path="/channels/:id" element={<ChannelDetailPage />} />
    </Routes>,
    { client: mockApi, path: "/channels/push_9" },
  );
}

const section = async (title: string) =>
  (await screen.findByRole("heading", { name: title })).closest("section")!;
const drawerOf = (title: string) =>
  screen.findByRole("dialog", { name: title });

async function openCampaign(file = csv(GOOD_CSV)) {
  await userEvent.click(
    await within(await section("Campaigns")).findByRole("button", {
      name: "New campaign",
    }),
  );
  const drawer = await drawerOf("New campaign");
  await userEvent.selectOptions(
    await within(drawer).findByLabelText("Template"),
    "pt_1",
  );
  await userEvent.upload(
    within(drawer).getByLabelText("Choose CSV file", { selector: "input" }),
    file,
  );
  return drawer;
}

beforeEach(() => {
  vi.clearAllMocks();
  // `clearAllMocks` keeps queued `…Once` answers: a failed test must not
  // hand its leftovers to the next one.
  for (const fn of Object.values(mockApi) as ReturnType<typeof vi.fn>[])
    if (fn !== mockApi.loginUrl) fn.mockReset();
  vi.mocked(mockApi.me).mockResolvedValue({
    id: "m_1",
    login: "alice",
    role: "member",
    via: "session",
  });
  vi.mocked(mockApi.channel).mockResolvedValue(CHANNEL);
  vi.mocked(mockApi.projectChannels).mockResolvedValue([]);
  vi.mocked(mockApi.limits).mockResolvedValue({
    scope: { kind: "channel", id: "push_9" },
    teamId: "team_1",
    limits: [],
    pending: [],
  });
  vi.mocked(mockApi.team).mockResolvedValue({
    id: "team_1",
    name: "studio",
    role: "member",
  });
  vi.mocked(mockApi.pushTemplates).mockResolvedValue({
    templates: [NOTICE, template()],
    max: 20,
  });
  vi.mocked(mockApi.pushJobs).mockResolvedValue({ jobs: [], next: null });
  vi.mocked(mockApi.createPushUpload).mockResolvedValue(GRANT);
  vi.mocked(mockApi.putPushUpload).mockResolvedValue(undefined);
  vi.mocked(mockApi.deletePushUpload).mockResolvedValue(undefined);
});

const closeDrawer = async (drawer: HTMLElement, title: string) => {
  await userEvent.click(within(drawer).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: title })).toBeNull(),
  );
};

describe("push templates", () => {
  it("lists name, title, variables and when it changed", async () => {
    mount();
    const s = await section("Templates");
    expect(await within(s).findByText(/2 of 20\./)).toBeInTheDocument();
    const row = (
      await within(s).findByRole("button", { name: "welcome" })
    ).closest("tr")!;
    expect(
      within(row).getByRole("button", {
        name: "Hi {{name}} — message of welcome",
      }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", {
        name: "name, score — variables of welcome",
      }),
    ).toBeInTheDocument();
    // The fold of the name carries the id the CLI takes and who changed it.
    const fold = within(row).getByRole("group", {
      name: "Template welcome",
      hidden: true,
    });
    expect(fold.textContent).toContain("pt_1");
    expect(fold.textContent).toContain("bob");
    const plain = within(s).getByRole("button", { name: "maintenance" });
    expect(within(plain.closest("tr")!).getByText("none")).toBeInTheDocument();
  });

  it("creates one after the client-side rules, with a live preview", async () => {
    vi.mocked(mockApi.createPushTemplate).mockResolvedValue(template());
    mount();
    await userEvent.click(
      await within(await section("Templates")).findByRole("button", {
        name: "New template",
      }),
    );
    const drawer = await drawerOf("New template");
    const submit = within(drawer).getByRole("button", {
      name: "Create template",
    });
    // Nothing typed: the rules answer, not the server.
    await userEvent.click(submit);
    expect(within(drawer).getByText("The name is required.")).toBeVisible();
    expect(
      within(drawer).getByText(/A title or at least one data key is required/),
    ).toBeInTheDocument();
    expect(mockApi.createPushTemplate).not.toHaveBeenCalled();

    await userEvent.type(within(drawer).getByLabelText(/^Name/), "bad name");
    expect(within(drawer).getByText(/Letters, digits/)).toBeInTheDocument();
    await userEvent.clear(within(drawer).getByLabelText(/^Name/));
    await userEvent.type(within(drawer).getByLabelText(/^Name/), "welcome");
    // `{` is userEvent's key syntax: set the values directly.
    fireEvent.change(within(drawer).getByLabelText(/^Title/), {
      target: { value: "Hi {{name}}" },
    });
    fireEvent.change(within(drawer).getByLabelText(/^Body/), {
      target: { value: "You scored {{score}} {{ not one }}" },
    });
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Add data key" }),
    );
    await userEvent.type(within(drawer).getByLabelText("Data key 1"), "from");
    expect(within(drawer).getByText(/FCM reserves the keys/)).toBeVisible();
    await userEvent.clear(within(drawer).getByLabelText("Data key 1"));
    await userEvent.type(within(drawer).getByLabelText("Data key 1"), "screen");
    await userEvent.type(within(drawer).getByLabelText("Data value 1"), "home");

    // The variables are found as typed, and sampled into the preview.
    const preview = within(drawer).getByRole("group", { name: "Preview" });
    expect(preview.textContent).toContain("Hi {{name}}");
    await userEvent.type(within(drawer).getByLabelText("Sample name"), "Al");
    await userEvent.type(within(drawer).getByLabelText("Sample score"), "42");
    expect(preview.textContent).toContain("Hi Al");
    expect(preview.textContent).toContain("You scored 42 {{ not one }}");
    expect(preview.textContent).toContain("screen: home");
    expect(preview.textContent).toMatch(/\d+ \/ 4,096 bytes/);

    await userEvent.click(submit);
    await waitFor(() =>
      expect(mockApi.createPushTemplate).toHaveBeenCalledWith("push_9", {
        name: "welcome",
        title: "Hi {{name}}",
        body: "You scored {{score}} {{ not one }}",
        data: { screen: "home" },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New template" })).toBeNull(),
    );
    expect(mockApi.pushTemplates).toHaveBeenCalledTimes(2);
  });

  it("shows a taken name under the name, and the cap as a sentence", async () => {
    vi.mocked(mockApi.createPushTemplate)
      .mockRejectedValueOnce(
        refusal(409, { reason: "push_template_name_taken" }),
      )
      .mockRejectedValueOnce(
        refusal(409, { reason: "push_template_cap", max: 20 }),
      )
      .mockRejectedValueOnce(
        refusal(400, { reason: "push_payload_too_large" }),
      );
    mount();
    await userEvent.click(
      await within(await section("Templates")).findByRole("button", {
        name: "New template",
      }),
    );
    const drawer = await drawerOf("New template");
    await userEvent.type(within(drawer).getByLabelText(/^Name/), "Welcome");
    await userEvent.type(within(drawer).getByLabelText(/^Title/), "Hi");
    const submit = within(drawer).getByRole("button", {
      name: "Create template",
    });
    await userEvent.click(submit);
    expect(
      await within(drawer).findByText(/Another template of this channel/),
    ).toBeInTheDocument();
    expect(within(drawer).queryByRole("alert")).toBeNull();
    await userEvent.click(submit);
    expect(
      (await within(drawer).findByText(/at most 20 templates/)).closest(
        '[role="alert"]',
      ),
    ).not.toBeNull();
    await userEvent.click(submit);
    expect(
      await within(drawer).findByText(/over 4,096 bytes/),
    ).toBeInTheDocument();
  });

  it("turns New template off at the cap", async () => {
    vi.mocked(mockApi.pushTemplates).mockResolvedValue({
      templates: Array.from({ length: 20 }, (_v, i) =>
        template({ id: `pt_${i}`, name: `t${i}` }),
      ),
      max: 20,
    });
    mount();
    const s = await section("Templates");
    expect(
      await within(s).findByText(/20 of 20\. Delete one to add another\./),
    ).toBeInTheDocument();
    expect(
      within(s).getByRole("button", { name: "New template" }),
    ).toBeDisabled();
    expect(within(s).getAllByRole("row")).toHaveLength(21);
  });

  it("edits with only what changed and deletes behind a confirm", async () => {
    vi.mocked(mockApi.updatePushTemplate).mockResolvedValue(template());
    vi.mocked(mockApi.deletePushTemplate).mockResolvedValue(undefined);
    mount();
    const s = await section("Templates");
    await userEvent.click(
      await within(s).findByRole("button", { name: "Actions for welcome" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Edit" }),
    );
    const drawer = await drawerOf("Edit template");
    expect(within(drawer).getByLabelText(/^Name/)).toHaveValue("welcome");
    expect(within(drawer).getByLabelText("Data key 1")).toHaveValue("screen");
    fireEvent.change(within(drawer).getByLabelText(/^Body/), {
      target: { value: "Score: {{score}}" },
    });
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updatePushTemplate).toHaveBeenCalledWith(
        "push_9",
        "pt_1",
        { body: "Score: {{score}}" },
      ),
    );

    await userEvent.click(
      await within(s).findByRole("button", { name: "Actions for welcome" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Delete welcome?",
    });
    expect(
      within(confirm).getByText(/Jobs already submitted keep the text/),
    ).toBeInTheDocument();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Delete template" }),
    );
    await waitFor(() =>
      expect(mockApi.deletePushTemplate).toHaveBeenCalledWith("push_9", "pt_1"),
    );
  });

  it("offers no template write to a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({
      id: "team_1",
      name: "studio",
      role: "admin",
    });
    mount();
    const s = await section("Templates");
    expect(
      await within(s).findByRole("button", { name: "welcome" }),
    ).toBeInTheDocument();
    expect(
      within(s).queryByRole("button", { name: "New template" }),
    ).toBeNull();
    expect(
      within(s).queryByRole("button", { name: "Actions for welcome" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "New campaign" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Send to everyone subscribed" }),
    ).toBeNull();
  });
});

describe("push campaign submit", () => {
  it("dry-runs first, then sends on the same upload with another key", async () => {
    const dry = job({
      id: "pj_dry",
      dryRun: true,
      report: null,
      counts: { ...job().counts, sent: 0, unregistered: 0, failed: 0 },
    });
    vi.mocked(mockApi.submitPushJob)
      .mockResolvedValueOnce({ job: dry, created: true })
      .mockResolvedValueOnce({
        job: job({ id: "pj_real", status: "queued" }),
        created: true,
      });
    mount();
    const drawer = await openCampaign();
    expect(
      await within(drawer).findByText("Columns: userId, name, score"),
    ).toBeInTheDocument();
    expect(within(drawer).getByText(/recipients\.csv · 26 B/)).toBeVisible();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Dry run" }),
    );
    await waitFor(() => expect(mockApi.submitPushJob).toHaveBeenCalledTimes(1));
    expect(mockApi.createPushUpload).toHaveBeenCalledWith("push_9", 26);
    expect(mockApi.putPushUpload).toHaveBeenCalledWith(GRANT, expect.any(File));
    const [, dryBody] = vi.mocked(mockApi.submitPushJob).mock.calls[0]!;
    expect(dryBody).toEqual({
      templateId: "pt_1",
      uploadId: "pu_7",
      dryRun: true,
      idempotencyKey: expect.stringMatching(
        /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/,
      ) as string,
    });

    // Its numbers, in the drawer that asked.
    const result = await within(drawer).findByRole("group", {
      name: "Dry run result",
    });
    for (const line of [
      "Rows1,200",
      "Resolved (would be sent)1,180",
      "No token15",
      "Duplicates3",
      "Missing variables2",
      "Invalid (user id, a value, or over 4,096 bytes)0",
    ])
      expect(result.textContent).toContain(line);
    expect(result.textContent).toContain("Nothing was sent");

    // The real job: a confirm, the same upload, a key of its own.
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Send campaign" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Send welcome to the users in recipients.csv?",
    });
    expect(mockApi.submitPushJob).toHaveBeenCalledTimes(1);
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Send campaign" }),
    );
    await waitFor(() => expect(mockApi.submitPushJob).toHaveBeenCalledTimes(2));
    const [, realBody] = vi.mocked(mockApi.submitPushJob).mock.calls[1]!;
    expect(realBody).toMatchObject({ templateId: "pt_1", uploadId: "pu_7" });
    expect(realBody).not.toHaveProperty("dryRun");
    expect(realBody.idempotencyKey).not.toBe(dryBody.idempotencyKey);
    expect(mockApi.createPushUpload).toHaveBeenCalledTimes(1);
    expect(mockApi.putPushUpload).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New campaign" })).toBeNull(),
    );
    // The day's usage moved: the limits are read again.
    await waitFor(() => expect(mockApi.limits).toHaveBeenCalledTimes(2));
    // Two jobs name the upload: it is not deleted with the drawer.
    expect(mockApi.deletePushUpload).not.toHaveBeenCalled();
  });

  it("deletes the upload when the drawer closes before any job used it", async () => {
    // Refused before a job exists; the delete itself may fail (best effort).
    vi.mocked(mockApi.submitPushJob).mockRejectedValue(
      refusal(409, { reason: "push_dry_run_cap", max: 20 }),
    );
    vi.mocked(mockApi.deletePushUpload).mockRejectedValue(refusal(429));
    mount();
    const drawer = await openCampaign();
    const dryRun = within(drawer).getByRole("button", { name: "Dry run" });
    await waitFor(() => expect(dryRun).toBeEnabled());
    await userEvent.click(dryRun);
    expect(
      await within(drawer).findByText(/ran its 20 dry runs for today/),
    ).toBeVisible();
    expect(mockApi.deletePushUpload).not.toHaveBeenCalled();
    await closeDrawer(drawer, "New campaign");
    expect(mockApi.deletePushUpload).toHaveBeenCalledTimes(1);
    expect(mockApi.deletePushUpload).toHaveBeenCalledWith("push_9", "pu_7");
  });

  it("keeps the upload a dry run used, and one a lost answer may have used", async () => {
    vi.mocked(mockApi.submitPushJob).mockResolvedValueOnce({
      job: job({ id: "pj_dry", dryRun: true }),
      created: true,
    });
    mount();
    let drawer = await openCampaign();
    let dryRun = within(drawer).getByRole("button", { name: "Dry run" });
    await waitFor(() => expect(dryRun).toBeEnabled());
    await userEvent.click(dryRun);
    await within(drawer).findByRole("group", { name: "Dry run result" });
    await closeDrawer(drawer, "New campaign");

    // No answer: the job may exist, so its upload is left alone.
    vi.mocked(mockApi.submitPushJob).mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    drawer = await openCampaign();
    dryRun = within(drawer).getByRole("button", { name: "Dry run" });
    await waitFor(() => expect(dryRun).toBeEnabled());
    await userEvent.click(dryRun);
    expect(await within(drawer).findByText("Failed to fetch")).toBeVisible();
    await closeDrawer(drawer, "New campaign");

    // Nothing was uploaded at all: nothing to delete.
    drawer = await openCampaign();
    await closeDrawer(drawer, "New campaign");
    expect(mockApi.deletePushUpload).not.toHaveBeenCalled();
  });

  it("retries the same submit with the same key, so the server replays it", async () => {
    vi.mocked(mockApi.submitPushJob)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        job: job({ id: "pj_dry", dryRun: true }),
        created: false,
      });
    mount();
    const drawer = await openCampaign();
    const dryRun = within(drawer).getByRole("button", { name: "Dry run" });
    await waitFor(() => expect(dryRun).toBeEnabled());
    await userEvent.click(dryRun);
    expect(await within(drawer).findByText("Failed to fetch")).toBeVisible();
    await userEvent.click(dryRun);
    await waitFor(() => expect(mockApi.submitPushJob).toHaveBeenCalledTimes(2));
    const [first, second] = vi
      .mocked(mockApi.submitPushJob)
      .mock.calls.map(([, b]) => b);
    expect(second).toEqual(first);
    // The file went up once; the retry reuses the upload.
    expect(mockApi.createPushUpload).toHaveBeenCalledTimes(1);
    expect(mockApi.putPushUpload).toHaveBeenCalledTimes(1);
  });

  it("retries a failed PUT on the same grant", async () => {
    vi.mocked(mockApi.putPushUpload).mockRejectedValueOnce(
      Object.assign(new Error("recipient CSV upload failed (403)"), {
        status: 403,
        code: "upload_failed",
      }),
    );
    vi.mocked(mockApi.submitPushJob).mockResolvedValue({
      job: job({ id: "pj_dry", dryRun: true }),
      created: true,
    });
    mount();
    const drawer = await openCampaign();
    const dryRun = within(drawer).getByRole("button", { name: "Dry run" });
    await waitFor(() => expect(dryRun).toBeEnabled());
    await userEvent.click(dryRun);
    expect(
      await within(drawer).findByText(/upload of the CSV to storage failed/),
    ).toBeVisible();
    expect(mockApi.submitPushJob).not.toHaveBeenCalled();
    await userEvent.click(dryRun);
    await waitFor(() => expect(mockApi.submitPushJob).toHaveBeenCalledTimes(1));
    expect(mockApi.createPushUpload).toHaveBeenCalledTimes(1);
    expect(mockApi.putPushUpload).toHaveBeenCalledTimes(2);
  });

  it("uploads anew after the server found the stored object unusable", async () => {
    vi.mocked(mockApi.submitPushJob)
      .mockRejectedValueOnce(refusal(409, { reason: "upload_missing" }))
      .mockResolvedValueOnce({
        job: job({ id: "pj_dry", dryRun: true }),
        created: true,
      });
    vi.mocked(mockApi.createPushUpload)
      .mockResolvedValueOnce(GRANT)
      .mockResolvedValueOnce({ ...GRANT, uploadId: "pu_8" });
    mount();
    const drawer = await openCampaign();
    const dryRun = within(drawer).getByRole("button", { name: "Dry run" });
    await waitFor(() => expect(dryRun).toBeEnabled());
    await userEvent.click(dryRun);
    expect(
      await within(drawer).findByText(/did not reach storage/),
    ).toBeVisible();
    await userEvent.click(dryRun);
    await waitFor(() => expect(mockApi.submitPushJob).toHaveBeenCalledTimes(2));
    expect(vi.mocked(mockApi.submitPushJob).mock.calls[1]![1].uploadId).toBe(
      "pu_8",
    );
    // The unusable one is given back; the one the dry run used is kept.
    expect(mockApi.deletePushUpload).toHaveBeenCalledTimes(1);
    expect(mockApi.deletePushUpload).toHaveBeenCalledWith("push_9", "pu_7");
    await closeDrawer(drawer, "New campaign");
    expect(mockApi.deletePushUpload).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["name,score\nAl,3\n", /no userId column/],
    [
      "userId,name,score,fcm_token\nu1,Al,3,x\n",
      /fcm_token reads like a device token/,
    ],
    ["userId,name\nu1,Al\n", /no column for \{\{score\}\}/],
  ])("refuses a bad header before anything is uploaded", async (text, why) => {
    mount();
    const drawer = await openCampaign(csv(text));
    expect(await within(drawer).findByText(why)).toBeVisible();
    expect(
      within(drawer).getByRole("button", { name: "Dry run" }),
    ).toBeDisabled();
    expect(
      within(drawer).getByRole("button", { name: "Send campaign" }),
    ).toBeDisabled();
    expect(mockApi.createPushUpload).not.toHaveBeenCalled();
  });

  it("sends the advanced options only when they are set", async () => {
    vi.mocked(mockApi.submitPushJob).mockResolvedValue({
      job: job({ id: "pj_dry", dryRun: true }),
      created: true,
    });
    mount();
    const drawer = await openCampaign();
    const toggle = within(drawer).getByRole("button", {
      name: "Advanced options",
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.selectOptions(
      within(drawer).getByLabelText("Priority"),
      "high",
    );
    await userEvent.type(
      within(drawer).getByLabelText(/^Time to live/),
      "3600",
    );
    await userEvent.type(within(drawer).getByLabelText(/^Collapse key/), "a b");
    expect(within(drawer).getByText(/printable ASCII/)).toBeVisible();
    expect(
      within(drawer).getByRole("button", { name: "Dry run" }),
    ).toBeDisabled();
    await userEvent.clear(within(drawer).getByLabelText(/^Collapse key/));
    await userEvent.type(
      within(drawer).getByLabelText(/^Collapse key/),
      "launch",
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Dry run" }),
    );
    await waitFor(() =>
      expect(mockApi.submitPushJob).toHaveBeenCalledWith(
        "push_9",
        expect.objectContaining({
          priority: "high",
          ttlSec: 3600,
          collapseKey: "launch",
        }),
      ),
    );
  });

  it("maps the server's refusals to where they can be acted on", async () => {
    vi.mocked(mockApi.submitPushJob)
      .mockRejectedValueOnce(
        refusal(400, { reason: "csv_invalid", csv: "quote", line: 1 }),
      )
      .mockRejectedValueOnce(
        refusal(409, { reason: "push_dry_run_cap", max: 20 }),
      )
      .mockRejectedValueOnce(refusal(503, { reason: "push_not_configured" }))
      .mockRejectedValueOnce(
        refusal(409, { limit: "push.jobsPerDay", value: 10 }),
      );
    mount();
    const drawer = await openCampaign();
    const dryRun = within(drawer).getByRole("button", { name: "Dry run" });
    await waitFor(() => expect(dryRun).toBeEnabled());
    await userEvent.click(dryRun);
    expect(
      await within(drawer).findByText(
        /The CSV was refused: a quote stands where it may not.*\(line 1\)/,
      ),
    ).toBeVisible();
    await userEvent.click(dryRun);
    expect(
      await within(drawer).findByText(/its 20 dry runs for today/),
    ).toBeVisible();
    await userEvent.click(dryRun);
    expect(
      await within(drawer).findByText(/Push is not set up on this stage/),
    ).toBeVisible();
    await userEvent.click(dryRun);
    expect(
      await within(drawer).findByText(/all 10 jobs it may today/),
    ).toBeVisible();
    // The limit refusal leads to the Limits section of the same page.
    const scroll = vi.spyOn(window.HTMLElement.prototype, "scrollIntoView");
    await userEvent.click(
      within(drawer).getByRole("button", {
        name: "Ask for more under Limits",
      }),
    );
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("limits"));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "New campaign" })).toBeNull(),
    );
    scroll.mockRestore();
  });
});

describe("push jobs", () => {
  const FAILED = job({
    id: "pj_bad",
    status: "failed",
    error: "recipients_over_limit",
    errorDetails: { limit: "push.recipientsPerJob", value: 10000 },
    author: "apikey",
    total: null,
    processed: 0,
    report: null,
    finishedAt: 1_790_000_010,
  });
  const RUNNING = job({
    id: "pj_run",
    status: "running",
    total: 1200,
    processed: 500,
    report: null,
    finishedAt: null,
    author: "m_0123456789abcdef0123456789abcdef",
  });

  it("lists jobs newest first with status, progress, outcome and author, and pages", async () => {
    vi.mocked(mockApi.pushJobs)
      .mockResolvedValueOnce({
        jobs: [RUNNING, job(), FAILED],
        next: "1790000000.pj_bad",
      })
      .mockResolvedValueOnce({
        jobs: [job({ id: "pj_old", kind: "broadcast", total: 1 })],
        next: null,
      });
    mount();
    const s = await section("Campaigns");
    await within(s).findByRole("button", { name: "Details of pj_run" });
    const rows = within(s).getAllByRole("row");
    expect(rows).toHaveLength(4);
    expect(rows[1]!.textContent).toContain("running");
    expect(rows[1]!.textContent).toContain("500 / 1,200");
    expect(rows[2]!.textContent).toContain("done");
    expect(rows[2]!.textContent).toContain("1,170 sent · 30 not");
    expect(rows[2]!.textContent).toContain("alice");
    expect(rows[3]!.textContent).toContain("failed");
    expect(rows[3]!.textContent).toContain("API key");
    await userEvent.click(within(s).getByRole("button", { name: "Load more" }));
    await waitFor(() =>
      expect(mockApi.pushJobs).toHaveBeenLastCalledWith(
        "push_9",
        "1790000000.pj_bad",
      ),
    );
    expect(await within(s).findByText("broadcast")).toBeInTheDocument();
    expect(within(s).queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("explains a failed job and why it has no report", async () => {
    vi.mocked(mockApi.pushJobs).mockResolvedValue({
      jobs: [FAILED],
      next: null,
    });
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Details of pj_bad" }),
    );
    const drawer = await drawerOf("Job");
    expect(
      (
        await within(drawer).findByText(
          /more rows than this channel's Recipients per job limit \(10,000\)/,
        )
      ).closest('[role="alert"]'),
    ).not.toBeNull();
    expect(
      within(drawer).getByRole("button", { name: "Download report" }),
    ).toBeDisabled();
    expect(
      within(drawer).getByText(/ended before its first batch/),
    ).toBeInTheDocument();
    // A finished job cannot be cancelled.
    expect(
      within(drawer).queryByRole("button", { name: "Cancel job" }),
    ).toBeNull();
    expect(within(drawer).getByText("pj_bad")).toBeInTheDocument();
  });

  it("downloads the report through its presigned URL", async () => {
    vi.mocked(mockApi.pushJobs).mockResolvedValue({
      jobs: [job()],
      next: null,
    });
    vi.mocked(mockApi.pushJobReport)
      .mockRejectedValueOnce(refusal(410))
      .mockResolvedValueOnce({
        url: "https://bucket.example.test/report?sig=1",
        expiresAt: 0,
        reportExpiresAt: 0,
      });
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Details of pj_1" }),
    );
    const drawer = await drawerOf("Job");
    for (const line of ["Sent1,170", "No token15", "Failed6", "Duplicates3"])
      expect(drawer.textContent).toContain(line);
    // What the invalid count holds, in the report's own reasons.
    expect(
      within(drawer).getByText(
        /skipped rows with the reason invalid-user .* too-large .* invalid-value/,
      ),
    ).toBeInTheDocument();
    expect(
      within(drawer).queryByText(/before the cancel took effect/),
    ).toBeNull();
    const button = within(drawer).getByRole("button", {
      name: "Download report",
    });
    await userEvent.click(button);
    expect(
      await within(drawer).findByText(/The report expired/),
    ).toBeInTheDocument();
    expect(openDownload).not.toHaveBeenCalled();
    await userEvent.click(button);
    await waitFor(() =>
      expect(openDownload).toHaveBeenCalledWith(
        "https://bucket.example.test/report?sig=1",
      ),
    );
    expect(mockApi.pushJobReport).toHaveBeenCalledWith("push_9", "pj_1");
  });

  it("cancels a running job behind a confirm", async () => {
    vi.mocked(mockApi.pushJobs).mockResolvedValue({
      jobs: [RUNNING],
      next: null,
    });
    vi.mocked(mockApi.cancelPushJob).mockResolvedValue({
      ...RUNNING,
      cancelRequested: true,
    });
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Details of pj_run" }),
    );
    const drawer = await drawerOf("Job");
    expect(
      within(drawer).getByText(/ready when the job has finished/),
    ).toBeInTheDocument();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Cancel job" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Cancel this job?",
    });
    expect(mockApi.cancelPushJob).not.toHaveBeenCalled();
    expect(
      within(confirm).getByText(/Rows already sent stay sent/),
    ).toBeInTheDocument();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Cancel job" }),
    );
    await waitFor(() =>
      expect(mockApi.cancelPushJob).toHaveBeenCalledWith("push_9", "pj_run"),
    );
    expect(
      await within(drawer).findByText(/Cancel requested: the job ends/),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByRole("button", { name: "Cancel job" }),
    ).toBeDisabled();
    expect(within(drawer).getByText("canceling")).toBeInTheDocument();
  });

  it("says a cancel came too late instead of failing", async () => {
    vi.mocked(mockApi.pushJobs).mockResolvedValue({
      jobs: [RUNNING],
      next: null,
    });
    // The last batch was running: the job ended done, the request on it.
    vi.mocked(mockApi.cancelPushJob).mockResolvedValue({
      ...RUNNING,
      status: "done",
      processed: 1200,
      cancelRequested: true,
      errorDetails: null,
      report: { available: true, expiresAt: 1_790_600_000 },
      finishedAt: 1_790_000_100,
    });
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "Details of pj_run" }),
    );
    const drawer = await drawerOf("Job");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Cancel job" }),
    );
    await userEvent.click(
      within(
        await screen.findByRole("dialog", { name: "Cancel this job?" }),
      ).getByRole("button", { name: "Cancel job" }),
    );
    const note = await within(drawer).findByText(
      /The job finished before the cancel took effect/,
    );
    // Information, not an alert; the job reads done and can be reported.
    expect(note.closest('[role="alert"]')).toBeNull();
    expect(within(drawer).getByText("done")).toBeInTheDocument();
    expect(within(drawer).queryByText("canceling")).toBeNull();
    expect(
      within(drawer).queryByRole("button", { name: "Cancel job" }),
    ).toBeNull();
    expect(
      within(drawer).getByRole("button", { name: "Download report" }),
    ).toBeEnabled();
  });

  describe("polling", () => {
    afterEach(() => {
      vi.useRealTimers();
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: false,
      });
    });
    const hide = (hidden: boolean) => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: hidden,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    };

    it("re-reads unfinished jobs while the tab is visible, and stops when none is left", async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      vi.mocked(mockApi.pushJobs).mockResolvedValue({
        jobs: [RUNNING, job()],
        next: null,
      });
      vi.mocked(mockApi.pushJob).mockResolvedValue({
        ...RUNNING,
        processed: 1000,
      });
      mount();
      const s = await section("Campaigns");
      expect(await within(s).findByText("500 / 1,200")).toBeInTheDocument();
      expect(mockApi.pushJob).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(PUSH_JOB_POLL_MS));
      // Only the unfinished one is read.
      expect(mockApi.pushJob).toHaveBeenCalledTimes(1);
      expect(mockApi.pushJob).toHaveBeenCalledWith("push_9", "pj_run");
      expect(await within(s).findByText("1,000 / 1,200")).toBeInTheDocument();

      // A hidden tab asks nothing; coming back resumes.
      act(() => hide(true));
      act(() => void vi.advanceTimersByTime(PUSH_JOB_POLL_MS * 3));
      expect(mockApi.pushJob).toHaveBeenCalledTimes(1);
      vi.mocked(mockApi.pushJob).mockResolvedValue({
        ...RUNNING,
        status: "done",
        processed: 1200,
        finishedAt: 1_790_000_100,
      });
      act(() => hide(false));
      act(() => void vi.advanceTimersByTime(PUSH_JOB_POLL_MS));
      expect(mockApi.pushJob).toHaveBeenCalledTimes(2);
      expect(await within(s).findByText("1,200 / 1,200")).toBeInTheDocument();

      // Nothing is running any more: no timer is left.
      act(() => void vi.advanceTimersByTime(PUSH_JOB_POLL_MS * 3));
      expect(mockApi.pushJob).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("push broadcast", () => {
  const openBroadcast = async () => {
    await userEvent.click(
      await within(await section("Broadcast")).findByRole("button", {
        name: "Send to everyone subscribed",
      }),
    );
    return drawerOf("Broadcast");
  };

  it("names the topic in the API block and in its own section", async () => {
    mount();
    expect(
      await screen.findByRole("button", { name: "Copy Broadcast topic" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the app subscribes to this topic/),
    ).toBeInTheDocument();
    const s = await section("Broadcast");
    expect(s.textContent).toContain("yyt.push.push_9");
    // A topic is not private: said where the broadcast is offered.
    expect(s.textContent).toMatch(
      /not confidential: anyone who holds the app can subscribe to the topic\. Put no secret, no personal data.*send private content with a campaign/,
    );
  });

  it("sends a template without variables after a confirm that says whom it reaches", async () => {
    vi.mocked(mockApi.pushBroadcast).mockResolvedValue({
      job: job({ id: "pj_b", kind: "broadcast", status: "queued" }),
      created: true,
    });
    mount();
    const drawer = await openBroadcast();
    const select = await within(drawer).findByLabelText("Message");
    // A template with variables cannot be broadcast.
    expect(
      within(select).getByRole("option", { name: "welcome (has variables)" }),
    ).toBeDisabled();
    await userEvent.selectOptions(select, "pt_2");
    expect(
      within(drawer).getByRole("group", { name: "Message" }).textContent,
    ).toContain("Maintenance at noon");
    expect(
      within(drawer).getByText(/A broadcast is not confidential/),
    ).toBeVisible();
    await userEvent.click(
      within(drawer).getByRole("button", {
        name: "Send to everyone subscribed",
      }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Send to everyone subscribed?",
    });
    expect(confirm.textContent).toContain(
      "This reaches every device subscribed to the channel topic yyt.push.push_9",
    );
    expect(confirm.textContent).toContain("counts as one job today");
    expect(confirm.textContent).toMatch(
      /not confidential: anyone who holds the app can subscribe.*no secret, no personal data.*campaign/,
    );
    expect(mockApi.pushBroadcast).not.toHaveBeenCalled();
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Send broadcast" }),
    );
    await waitFor(() =>
      expect(mockApi.pushBroadcast).toHaveBeenCalledWith("push_9", {
        templateId: "pt_2",
        idempotencyKey: expect.stringMatching(/^ui-/) as string,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Broadcast" })).toBeNull(),
    );
    await waitFor(() => expect(mockApi.limits).toHaveBeenCalledTimes(2));
  });

  it("does nothing when the confirm is declined", async () => {
    mount();
    const drawer = await openBroadcast();
    await userEvent.type(within(drawer).getByLabelText(/^Title/), "Hello");
    await userEvent.click(
      within(drawer).getByRole("button", {
        name: "Send to everyone subscribed",
      }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Send to everyone subscribed?",
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Send to everyone subscribed?" }),
      ).toBeNull(),
    );
    expect(mockApi.pushBroadcast).not.toHaveBeenCalled();
    expect(
      screen.getByRole("dialog", { name: "Broadcast" }),
    ).toBeInTheDocument();
  });

  it("sends an inline message, refuses a variable, and replays a retry", async () => {
    vi.mocked(mockApi.pushBroadcast)
      .mockRejectedValueOnce(
        refusal(409, { limit: "push.jobsPerDay", value: 10 }),
      )
      .mockResolvedValueOnce({
        job: job({ id: "pj_b", kind: "broadcast" }),
        created: false,
      });
    mount();
    const drawer = await openBroadcast();
    const submit = within(drawer).getByRole("button", {
      name: "Send to everyone subscribed",
    });
    // Nothing typed: the template rules answer.
    await userEvent.click(submit);
    expect(
      await within(drawer).findByText(/A title or at least one data key/),
    ).toBeInTheDocument();
    fireEvent.change(within(drawer).getByLabelText(/^Title/), {
      target: { value: "Hi {{name}}" },
    });
    expect(
      within(drawer).getByText(/A broadcast cannot hold \{\{variables\}\}/),
    ).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.change(within(drawer).getByLabelText(/^Title/), {
      target: { value: "Server is back" },
    });
    await userEvent.type(within(drawer).getByLabelText(/^Body/), "Come play");
    const send = async () => {
      await userEvent.click(submit);
      await userEvent.click(
        within(
          await screen.findByRole("dialog", {
            name: "Send to everyone subscribed?",
          }),
        ).getByRole("button", { name: "Send broadcast" }),
      );
    };
    await send();
    expect(
      await within(drawer).findByText(/all 10 jobs it may today/),
    ).toBeVisible();
    expect(
      within(drawer).getByRole("button", { name: "Ask for more under Limits" }),
    ).toBeInTheDocument();
    await send();
    await waitFor(() => expect(mockApi.pushBroadcast).toHaveBeenCalledTimes(2));
    const [first, second] = vi
      .mocked(mockApi.pushBroadcast)
      .mock.calls.map(([, b]) => b);
    expect(first).toEqual({
      title: "Server is back",
      body: "Come play",
      data: {},
      idempotencyKey: expect.any(String) as string,
    });
    expect(second).toEqual(first);
  });
});

describe("push channel limits", () => {
  it("labels the two campaign keys and asks for more jobs per day", async () => {
    vi.mocked(mockApi.limits).mockResolvedValue({
      scope: { kind: "channel", id: "push_9" },
      teamId: "team_1",
      limits: [
        limitRow("push.recipientsPerJob", {
          soft: 10_000,
          hard: 100_000,
          effective: 10_000,
        }),
        limitRow("push.jobsPerDay", { usage: 10 }),
      ],
      pending: [],
    });
    vi.mocked(mockApi.requestLimit).mockResolvedValue({} as never);
    mount();
    const s = await section("Limits");
    expect(s.id).toBe("limits");
    const recipients = (
      await within(s).findByText("Recipients per job")
    ).closest("tr")!;
    // Nothing is counted for a per-job bound.
    expect(
      within(recipients)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["Recipients per job", "—", "10,000", "100,000"]);
    expect(
      within(within(s).getByText("Jobs per day").closest("tr")!)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["Jobs per day", "10", "10", "100"]);
    await userEvent.click(
      within(s).getByRole("button", { name: "Request increase" }),
    );
    const drawer = await drawerOf("Request increase");
    await userEvent.selectOptions(
      within(drawer).getByLabelText("Limit"),
      "push.jobsPerDay",
    );
    await userEvent.type(
      within(drawer).getByRole("textbox", { name: /^Value/ }),
      "50",
    );
    await userEvent.type(
      within(drawer).getByLabelText(/^Reason/),
      "launch week",
    );
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Send request" }),
    );
    await waitFor(() =>
      expect(mockApi.requestLimit).toHaveBeenCalledWith({
        scope: "channel:push_9",
        key: "push.jobsPerDay",
        value: 50,
        reason: "launch week",
      }),
    );
  });
});
