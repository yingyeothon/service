import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type * as PushLib from "../src/lib/push";
import type { Channel } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  channel: vi.fn(),
  team: vi.fn(),
  projectChannels: vi.fn(),
  limits: vi.fn(),
  updateChannel: vi.fn(),
  rotateChannelSecret: vi.fn(),
  deleteChannel: vi.fn(),
  setChannelSenderKey: vi.fn(),
  removeChannelSenderKey: vi.fn(),
  channelGoogleServices: vi.fn(),
  channelGoogleServiceInfo: vi.fn(),
  addChannelIos: vi.fn(),
  pushTemplates: vi.fn(),
  pushJobs: vi.fn(),
  pushUploads: vi.fn(),
  pushStats: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const saveBlob = vi.fn();
vi.mock("../src/lib/push", async (orig) => ({
  ...(await orig<typeof PushLib>()),
  saveBlob,
}));

const { ChannelDetailPage } = await import("../src/pages/ChannelDetail");
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
};
const TEAM_SENDER: Channel = {
  ...CHANNEL,
  config: { ...CHANNEL.config, sender: "team" },
  registered: false,
  teamProject: "team-proj",
};
// Not a key: only that it is sent, and never rendered, matters here.
const KEY = '{"type":"service_account","project_id":"team-proj"}';
const refusal = (status: number, details: unknown) =>
  Object.assign(new Error("refused"), { status, details });

function mount() {
  return mountWith(
    <Routes>
      <Route path="/channels/:id" element={<ChannelDetailPage />} />
      <Route path="/teams/:team/projects/:prj/:tab" element={<p>project</p>} />
    </Routes>,
    { client: mockApi, path: "/channels/push_9" },
  );
}

const iosSection = async () =>
  (await screen.findByRole("heading", { name: "iOS app" })).closest("section")!;
const WITH_IOS: Channel = {
  ...CHANNEL,
  config: { ...CHANNEL.config, iosBundleId: "com.example.game-ios" },
  iosRegistered: true,
  apnsState: "pending",
};

const senderSection = async () =>
  (await screen.findByRole("heading", { name: "Team sender key" })).closest(
    "section",
  )!;

describe("push channel page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "m_1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.channel).mockResolvedValue(CHANNEL);
    vi.mocked(mockApi.projectChannels).mockResolvedValue([]);
    vi.mocked(mockApi.pushTemplates).mockResolvedValue({
      templates: [],
      max: 20,
    });
    vi.mocked(mockApi.pushJobs).mockResolvedValue({ jobs: [], next: null });
    vi.mocked(mockApi.pushUploads).mockResolvedValue({
      uploads: [],
      next: null,
      max: 20,
    });
    vi.mocked(mockApi.pushStats).mockResolvedValue({
      tokens: { count: 0, capped: false },
      tokenCap: 10_000,
      since: "2026-09-28",
      days: [],
    });
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
  });

  it("shows the package, the sender, the registration and the state routes", async () => {
    mount();
    expect(await screen.findByText("com.example.game")).toBeInTheDocument();
    expect(screen.getByText("registered")).toBeInTheDocument();
    expect(screen.getByText(/Sender: platform/)).toBeInTheDocument();
    expect(screen.queryByText("Team project")).toBeNull();
    // One copyable block, a route per line.
    const routes = screen.getByLabelText("Push routes");
    expect(routes.textContent).toBe(
      [
        "PUT https://state.example.test/push/push_9/token",
        "DELETE https://state.example.test/push/push_9/token",
        "POST https://state.example.test/push/push_9/send",
      ].join("\n"),
    );
    for (const label of ["API base", "Push routes"])
      expect(
        screen.getByRole("button", { name: `Copy ${label}` }),
      ).toBeInTheDocument();
  });

  it("shows the device tokens against the cap and the days' send counters", async () => {
    vi.mocked(mockApi.pushStats).mockResolvedValue({
      tokens: { count: 1234, capped: false },
      tokenCap: 10_000,
      since: "2026-09-28",
      days: [
        {
          day: "2026-10-11",
          calls: 3,
          sent: 1500,
          noToken: 20,
          failed: 4,
          unregistered: 2,
        },
      ],
    });
    mount();
    const s = (
      await screen.findByRole("heading", { name: "Delivery" })
    ).closest("section")!;
    expect(
      await within(s).findByText("Device tokens: 1,234 of 10,000"),
    ).toBeInTheDocument();
    const row = within(s).getByText("2026-10-11").closest("tr")!;
    expect(
      within(row)
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual(["2026-10-11", "3", "1,500", "20", "4", "2"]);
    expect(mockApi.pushStats).toHaveBeenCalledWith("push_9");
  });

  it("says when the channel is full and when nothing was sent", async () => {
    vi.mocked(mockApi.pushStats).mockResolvedValue({
      tokens: { count: 20_000, capped: true },
      tokenCap: 20_000,
      since: "2026-09-28",
      days: [],
    });
    mount();
    const s = (
      await screen.findByRole("heading", { name: "Delivery" })
    ).closest("section")!;
    expect(
      await within(s).findByText(
        /20,000 of 20,000 — full: a new device is refused/,
      ),
    ).toBeInTheDocument();
    expect(
      within(s).getByText("No sends in the last 14 days."),
    ).toBeInTheDocument();
    expect(
      within(s).getByText("Counted since 2026-09-28."),
    ).toBeInTheDocument();
  });

  it("says so when the stage has no state service", async () => {
    vi.mocked(mockApi.channel).mockResolvedValue({
      ...CHANNEL,
      apiBase: undefined,
    });
    mount();
    expect(
      await screen.findByText(/state service is not deployed on this stage/),
    ).toBeInTheDocument();
    expect(screen.queryByText("API base")).toBeNull();
  });

  it("downloads google-services.json through the authenticated client", async () => {
    const blob = new Blob(["{}"], { type: "application/json" });
    vi.mocked(mockApi.channelGoogleServices).mockResolvedValue({
      blob,
      filename: "google-services.json",
    });
    mount();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Download google-services.json",
      }),
    );
    await waitFor(() =>
      expect(saveBlob).toHaveBeenCalledWith(blob, "google-services.json"),
    );
    expect(mockApi.channelGoogleServices).toHaveBeenCalledWith("push_9");
  });

  it("explains a download the platform could not serve", async () => {
    vi.mocked(mockApi.channelGoogleServices).mockRejectedValue(
      refusal(503, { reason: "firebase_unavailable" }),
    );
    mount();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Download google-services.json",
      }),
    );
    expect(
      (await screen.findByText(/Firebase did not answer the platform/)).closest(
        '[role="alert"]',
      ),
    ).not.toBeNull();
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("says a rate-limited download is not the channel's fault", async () => {
    vi.mocked(mockApi.channelGoogleServices).mockRejectedValue(
      refusal(429, { retryAfterMs: 500 }),
    );
    mount();
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Download google-services.json",
      }),
    );
    expect(
      (await screen.findByText(/each download is a call to Firebase/)).closest(
        '[role="alert"]',
      ),
    ).not.toBeNull();
    expect(saveBlob).not.toHaveBeenCalled();
  });

  it("explains an edit refused while the registration is under way", async () => {
    vi.mocked(mockApi.projectChannels).mockResolvedValue([
      { ...CHANNEL, id: "auth_1", kind: "auth", name: "login" },
    ]);
    vi.mocked(mockApi.updateChannel).mockRejectedValue(
      refusal(409, { reason: "not_registered" }),
    );
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    expect(
      await screen.findByText(/registration with Firebase is not finished/),
    ).toBeInTheDocument();
  });

  it("disables the download, with the reason on screen, while not registered", async () => {
    vi.mocked(mockApi.channel).mockResolvedValue(TEAM_SENDER);
    const team = mount();
    expect(
      await screen.findByRole("button", {
        name: "Download google-services.json",
      }),
    ).toBeDisabled();
    expect(
      screen.getByText(/A team-sender channel has no platform registration/),
    ).toBeInTheDocument();
    expect(screen.getByText("not registered")).toBeInTheDocument();
    expect(screen.getAllByText("team-proj").length).toBeGreaterThan(0);
    team.unmount();

    vi.mocked(mockApi.channel).mockResolvedValue({
      ...CHANNEL,
      registered: false,
    });
    mount();
    expect(
      await screen.findByRole("button", {
        name: "Download google-services.json",
      }),
    ).toBeDisabled();
    expect(
      screen.getByText(/so there is no file to download/),
    ).toBeInTheDocument();
  });

  it("registers a team sender key from a masked field and never shows it", async () => {
    vi.mocked(mockApi.setChannelSenderKey)
      .mockRejectedValueOnce(
        refusal(400, { reason: "service_account", field: "private_key" }),
      )
      .mockResolvedValueOnce({ ...CHANNEL, teamProject: "team-proj" });
    mount();
    const s = await senderSection();
    expect(within(s).getByText(/No team key/)).toBeInTheDocument();
    await userEvent.click(
      await within(s).findByRole("button", { name: "Register key" }),
    );
    expect(within(s).queryByRole("button", { name: "Remove key" })).toBeNull();
    const drawer = await screen.findByRole("dialog");
    const submit = within(drawer).getByRole("button", {
      name: "Register key",
    });
    expect(submit).toBeDisabled();
    const field = within(drawer).getByLabelText(/^Service-account key/);
    expect(field).toHaveAttribute("type", "password");
    await userEvent.click(field);
    await userEvent.paste(KEY);
    await userEvent.click(submit);
    // The server's refusal names the part of the key, under the field.
    await waitFor(() => expect(field).toBeInvalid());
    expect(field).toHaveAccessibleDescription(
      /private_key is missing or not a usable RSA key/,
    );
    expect(
      screen.getAllByText(/private_key is missing or not a usable RSA key/),
    ).toHaveLength(1);

    await userEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockApi.setChannelSenderKey).toHaveBeenLastCalledWith("push_9", KEY);
    expect(
      await within(s).findByText(/Registered for the Firebase project/),
    ).toBeInTheDocument();
    expect(within(s).getByText("team-proj")).toBeInTheDocument();
    expect(
      within(s).getByRole("button", { name: "Rotate key" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(KEY, { exact: false })).toBeNull();
    expect(document.body.innerHTML).not.toContain("service_account");
  });

  it("removes a platform channel's team key after a confirm", async () => {
    vi.mocked(mockApi.channel)
      .mockResolvedValueOnce({ ...CHANNEL, teamProject: "team-proj" })
      .mockResolvedValue(CHANNEL);
    vi.mocked(mockApi.removeChannelSenderKey).mockResolvedValue({
      removed: true,
    });
    mount();
    const s = await senderSection();
    await userEvent.click(
      await within(s).findByRole("button", { name: "Remove key" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(/stops sending to devices registered/);
    expect(mockApi.removeChannelSenderKey).not.toHaveBeenCalled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Remove sender key" }),
    );
    await waitFor(() =>
      expect(mockApi.removeChannelSenderKey).toHaveBeenCalledWith("push_9"),
    );
    expect(await within(s).findByText(/No team key/)).toBeInTheDocument();
  });

  it("keeps Remove off on a team-sender channel and says why", async () => {
    vi.mocked(mockApi.channel).mockResolvedValue(TEAM_SENDER);
    mount();
    const s = await senderSection();
    expect(
      await within(s).findByRole("button", { name: "Remove key" }),
    ).toBeDisabled();
    expect(
      within(s).getByText(/the key is this team-sender channel’s only sender/),
    ).toBeInTheDocument();
    expect(within(s).getByRole("button", { name: "Rotate key" })).toBeEnabled();
  });

  it("rotates the API key and shows the new one once", async () => {
    vi.mocked(mockApi.rotateChannelSecret).mockResolvedValue({
      ...CHANNEL,
      apiKey: "new-api-key",
    });
    mount();
    await userEvent.click(
      await screen.findByRole("button", { name: "More actions" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Rotate api key" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Rotate api key",
      }),
    );
    expect(await screen.findByText("new-api-key")).toBeInTheDocument();
  });

  it("edits only the name and the auth channel, and deletes with the push warning", async () => {
    vi.mocked(mockApi.projectChannels).mockResolvedValue([
      { ...CHANNEL, id: "auth_1", kind: "auth", name: "login" },
      { ...CHANNEL, id: "auth_2", kind: "auth", name: "login-2" },
    ]);
    vi.mocked(mockApi.updateChannel).mockResolvedValue(CHANNEL);
    vi.mocked(mockApi.deleteChannel).mockResolvedValue(undefined);
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByLabelText(/^Package name/)).toBeDisabled();
    expect(within(drawer).getByLabelText(/^Sender/)).toBeDisabled();
    expect(within(drawer).queryByLabelText(/^Service-account key/)).toBeNull();
    await userEvent.selectOptions(
      within(drawer).getByLabelText(/^Auth channel/),
      "auth_2",
    );
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateChannel).toHaveBeenCalledWith("push_9", {
        name: "alerts",
        config: { authChannelId: "auth_2" },
      }),
    );

    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const again = await screen.findByRole("dialog");
    expect(again).toHaveTextContent(
      /Firebase registration and every device token registered on it are deleted/,
    );
    await userEvent.click(
      within(again).getByRole("button", { name: "Delete channel" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Delete channel?",
    });
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Delete channel" }),
    );
    await waitFor(() =>
      expect(mockApi.deleteChannel).toHaveBeenCalledWith("push_9"),
    );
  });

  it("hides the key verbs from a seatless admin but still offers the download", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({
      id: "team_1",
      name: "studio",
      role: "admin",
    });
    mount();
    const s = await senderSection();
    expect(
      await screen.findByRole("button", {
        name: "Download google-services.json",
      }),
    ).toBeEnabled();
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(
      within(s).queryByRole("button", { name: "Register key" }),
    ).toBeNull();
  });

  describe("iOS app", () => {
    it("adds an iOS app from the drawer, refusals under the field", async () => {
      vi.mocked(mockApi.addChannelIos)
        .mockRejectedValueOnce(refusal(409, { reason: "bundle_taken" }))
        .mockRejectedValueOnce(refusal(503, { reason: "push_slot_full" }))
        .mockResolvedValueOnce(WITH_IOS);
      mount();
      const s = await iosSection();
      expect(within(s).getByText(/No iOS app/)).toBeInTheDocument();
      await userEvent.click(
        await within(s).findByRole("button", { name: "Add iOS app" }),
      );
      const drawer = await screen.findByRole("dialog");
      const field = within(drawer).getByLabelText(/^iOS bundle id/);
      expect(field).toHaveAccessibleDescription(/Fixed once added/);
      const submit = within(drawer).getByRole("button", {
        name: "Add iOS app",
      });
      expect(submit).toBeDisabled();
      // The grammar is checked before any request.
      await userEvent.type(field, "game");
      await userEvent.click(submit);
      await waitFor(() => expect(field).toBeInvalid());
      expect(mockApi.addChannelIos).not.toHaveBeenCalled();

      await userEvent.clear(field);
      await userEvent.type(field, " com.example.game-ios ");
      await userEvent.click(submit);
      await waitFor(() =>
        expect(field).toHaveAccessibleDescription(
          /bundle id is already registered/,
        ),
      );
      expect(mockApi.addChannelIos).toHaveBeenLastCalledWith(
        "push_9",
        "com.example.game-ios",
      );

      // A full slot is not the field's: it goes to the drawer's notice.
      await userEvent.click(submit);
      expect(
        (
          await within(drawer).findByText(/never moves to another project/)
        ).closest('[role="alert"]'),
      ).not.toBeNull();
      expect(field).toBeValid();

      await userEvent.click(submit);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(
        await within(s).findByText("com.example.game-ios"),
      ).toBeInTheDocument();
      expect(
        within(s).queryByRole("button", { name: "Add iOS app" }),
      ).toBeNull();
      expect(within(s).getByText("APNs pending")).toBeInTheDocument();
    });

    it("shows the pending notice and downloads the plist", async () => {
      vi.mocked(mockApi.channel).mockResolvedValue(WITH_IOS);
      const blob = new Blob(["<plist/>"], { type: "application/x-plist" });
      vi.mocked(mockApi.channelGoogleServiceInfo).mockResolvedValue({
        blob,
        filename: "GoogleService-Info.plist",
      });
      mount();
      const s = await iosSection();
      expect(within(s).getByText("com.example.game-ios")).toBeInTheDocument();
      const notice = within(s)
        .getByText(/has to upload this app's own APNs certificate \(\.p12\)/)
        .closest('[role="status"]');
      expect(notice).toHaveTextContent(
        /Do not upload the certificate to the console/,
      );
      await userEvent.click(
        within(s).getByRole("button", {
          name: "Download GoogleService-Info.plist",
        }),
      );
      await waitFor(() =>
        expect(saveBlob).toHaveBeenCalledWith(blob, "GoogleService-Info.plist"),
      );
      expect(mockApi.channelGoogleServiceInfo).toHaveBeenCalledWith("push_9");
    });

    it("explains a plist the platform has not got", async () => {
      vi.mocked(mockApi.channel).mockResolvedValue({
        ...WITH_IOS,
        apnsState: "ready",
      });
      vi.mocked(mockApi.channelGoogleServiceInfo).mockRejectedValue(
        refusal(409, { reason: "not_registered" }),
      );
      mount();
      const s = await iosSection();
      expect(within(s).getByText("APNs ready")).toBeInTheDocument();
      expect(within(s).getByText(/expires yearly/)).toBeInTheDocument();
      expect(within(s).queryByText(/Do not upload the certificate/)).toBeNull();
      await userEvent.click(
        within(s).getByRole("button", {
          name: "Download GoogleService-Info.plist",
        }),
      );
      expect(
        await within(s).findByText(/no GoogleService-Info.plist to download/),
      ).toBeInTheDocument();
      expect(saveBlob).not.toHaveBeenCalled();
    });

    it("disables the plist while the iOS app is not registered", async () => {
      vi.mocked(mockApi.channel).mockResolvedValue({
        ...WITH_IOS,
        iosRegistered: false,
      });
      mount();
      const s = await iosSection();
      expect(
        within(s).getByRole("button", {
          name: "Download GoogleService-Info.plist",
        }),
      ).toBeDisabled();
      expect(
        within(s).getByText(/not registered on the platform/),
      ).toBeInTheDocument();
    });

    it("tells a team sender its APNs credential is its own", async () => {
      vi.mocked(mockApi.channel).mockResolvedValue({
        ...TEAM_SENDER,
        config: { ...TEAM_SENDER.config, iosBundleId: "com.example.game" },
        iosRegistered: false,
        apnsState: "team",
      });
      mount();
      const s = await iosSection();
      expect(within(s).getByText("APNs: team")).toBeInTheDocument();
      expect(
        within(s).getByText(
          /uploads its own APNs credential in its own Firebase project/,
        ),
      ).toBeInTheDocument();
      expect(
        within(s).queryByRole("button", {
          name: "Download GoogleService-Info.plist",
        }),
      ).toBeNull();
      expect(within(s).queryByText(/Do not upload the certificate/)).toBeNull();
    });

    it("offers no add to a seatless admin", async () => {
      vi.mocked(mockApi.team).mockResolvedValue({
        id: "team_1",
        name: "studio",
        role: "admin",
      });
      mount();
      const s = await iosSection();
      expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
      expect(
        within(s).queryByRole("button", { name: "Add iOS app" }),
      ).toBeNull();
    });
  });
});
