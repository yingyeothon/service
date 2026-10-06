import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { Channel, ChannelKind, ProjectDetail } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  project: vi.fn(),
  channel: vi.fn(),
  channels: vi.fn(),
  projectChannels: vi.fn(),
  limits: vi.fn(),
  createChannel: vi.fn(),
  updateChannel: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { ChannelDetailPage } = await import("../src/pages/ChannelDetail");
const { ChannelNewPage } = await import("../src/pages/ChannelNew");
const { ChannelsPage } = await import("../src/pages/Channels");
const { mount } = await import("./wrap");

const row = {
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "dungeon",
  createdBy: "alice",
  createdAt: 0,
  expiresAt: 1,
  disabledAt: null,
  status: "active",
} as const;
const AUTH: Channel = {
  ...row,
  id: "auth_1",
  kind: "auth",
  name: "login",
  config: {
    audience: "game",
    tokenTtlSec: 3600,
    redirectAllowlist: [],
    providers: {},
  },
};
const AUTH_2: Channel = { ...AUTH, id: "auth_2", name: "staging" };
const push = (id: string, name: string, over: Partial<Channel> = {}) =>
  ({
    ...row,
    id,
    kind: "push",
    name,
    config: {
      authChannelId: "auth_1",
      packageName: "com.example.game",
      sender: "platform",
    },
    ...over,
  }) satisfies Channel;
const PUSH = push("push_1", "alerts");
const PUSHES: Channel[] = [
  PUSH,
  push("push_2", "elsewhere", {
    config: { ...PUSH.config, authChannelId: "auth_2" },
  }),
  push("push_3", "lapsed", { status: "expired" }),
];
const LIVE: Channel = {
  ...row,
  id: "match_1",
  kind: "match",
  name: "duel",
  config: {
    authChannelId: "auth_1",
    partySize: 2,
    waitTimeoutSec: 60,
    onTimeout: "fail",
  },
  wsUrl: "wss://match.example.test/?channel=match_1",
};
const DEFERRED: Channel = {
  ...row,
  id: "match_2",
  kind: "match",
  name: "league",
  config: {
    authChannelId: "auth_1",
    partySize: 4,
    waitTimeoutSec: 900,
    onTimeout: "partial",
    mode: "deferred",
    acceptTimeoutSec: 45,
    resultTtlSec: 1200,
    pushChannelId: "push_1",
  },
  apiBase: "https://match-api.example.test",
  ticketUrl: "https://match-api.example.test/m/match_2/ticket",
};
const PROJECT: ProjectDetail = {
  id: "prj_1",
  teamId: "team_1",
  teamName: "studio",
  name: "dungeon",
  description: null,
  createdBy: "alice",
  createdAt: 0,
  updatedAt: 0,
  counts: {
    channels: 0,
    apps: 0,
    bundles: 0,
    sites: 0,
    kv: 0,
    lb: 0,
    versions: 0,
    issues: 0,
  },
};
const refusal = (message: string, details?: unknown) =>
  Object.assign(new Error(message), { status: 400, details });
const options = (el: HTMLElement) =>
  within(el)
    .getAllByRole<HTMLOptionElement>("option")
    .map((o) => o.value);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockApi.me).mockResolvedValue({
    id: "u1",
    login: "alice",
    role: "member",
    via: "session",
  });
  vi.mocked(mockApi.team).mockResolvedValue({
    id: "team_1",
    name: "studio",
    role: "member",
  });
  vi.mocked(mockApi.project).mockResolvedValue(PROJECT);
  vi.mocked(mockApi.projectChannels).mockImplementation(
    (_prj: string, kind?: ChannelKind) =>
      Promise.resolve(kind === "push" ? PUSHES : [AUTH, AUTH_2]),
  );
  vi.mocked(mockApi.limits).mockResolvedValue({
    scope: { kind: "channel", id: "match_2" },
    teamId: "team_1",
    limits: [],
    pending: [],
  });
});

describe("match channel: create form", () => {
  async function open() {
    mount(
      <Routes>
        <Route
          path="/teams/:team/projects/:prj/channels/new"
          element={<ChannelNewPage />}
        />
        <Route path="/channels/:id" element={<p>created</p>} />
      </Routes>,
      { client: mockApi, path: "/teams/team_1/projects/prj_1/channels/new" },
    );
    await userEvent.selectOptions(
      await screen.findByLabelText("Kind"),
      "match",
    );
    await userEvent.type(screen.getByLabelText(/^Name/), "league");
    await userEvent.selectOptions(
      await screen.findByLabelText(/^Auth channel/),
      "auth_1",
    );
  }
  const create = () =>
    userEvent.click(screen.getByRole("button", { name: "Create channel" }));

  it("is live by default and sends the config a live channel always had", async () => {
    vi.mocked(mockApi.createChannel).mockResolvedValue({
      ...LIVE,
      apiKey: "k",
    });
    await open();
    expect(screen.getByLabelText(/^Mode/)).toHaveValue("live");
    expect(
      screen.getByLabelText(/^Wait timeout \(seconds, 5–600\)/),
    ).toHaveValue(60);
    for (const label of [/^Accept window/, /^Result TTL/, /^Push channel/])
      expect(screen.queryByLabelText(label)).toBeNull();
    await create();
    await waitFor(() =>
      expect(mockApi.createChannel).toHaveBeenCalledWith("prj_1", {
        kind: "match",
        name: "league",
        config: {
          authChannelId: "auth_1",
          partySize: 2,
          waitTimeoutSec: 60,
          onTimeout: "fail",
        },
      }),
    );
  });

  it("deferred reveals its fields, moves the wait bounds and lists the auth channel's push channels", async () => {
    vi.mocked(mockApi.createChannel).mockResolvedValue({
      ...DEFERRED,
      apiKey: "k",
    });
    await open();
    await userEvent.selectOptions(screen.getByLabelText(/^Mode/), "deferred");
    expect(
      screen.getByLabelText(/^Wait timeout \(seconds, 30–7200\)/),
    ).toHaveValue(600);
    expect(
      screen.getByLabelText(/^Accept window \(seconds, 30–600\)/),
    ).toHaveValue(120);
    expect(
      screen.getByLabelText(/^Result TTL \(seconds, 60–3600\)/),
    ).toHaveValue(600);
    // Active, and on the selected auth channel: one of the project's three.
    const picker = await screen.findByLabelText(/^Push channel/);
    await waitFor(() => expect(options(picker)).toEqual(["", "push_1"]));
    expect(mockApi.projectChannels).toHaveBeenCalledWith("prj_1", "push");
    await userEvent.selectOptions(picker, "push_1");

    // The picked channel does not follow the form to another auth channel.
    await userEvent.selectOptions(
      screen.getByLabelText(/^Auth channel/),
      "auth_2",
    );
    expect(picker).toHaveValue("");
    expect(options(picker)).toEqual(["", "push_2"]);
    await userEvent.selectOptions(
      screen.getByLabelText(/^Auth channel/),
      "auth_1",
    );
    await userEvent.selectOptions(picker, "push_1");

    await create();
    await waitFor(() =>
      expect(mockApi.createChannel).toHaveBeenCalledWith("prj_1", {
        kind: "match",
        name: "league",
        config: {
          authChannelId: "auth_1",
          partySize: 2,
          waitTimeoutSec: 600,
          onTimeout: "fail",
          mode: "deferred",
          acceptTimeoutSec: 120,
          resultTtlSec: 600,
          pushChannelId: "push_1",
        },
      }),
    );
  });

  it("reports a value outside the mode's bounds under its field, before any request", async () => {
    await open();
    await userEvent.selectOptions(screen.getByLabelText(/^Mode/), "deferred");
    const wait = screen.getByLabelText(/^Wait timeout/);
    await userEvent.clear(wait);
    await userEvent.type(wait, "7201");
    const accept = screen.getByLabelText(/^Accept window/);
    await userEvent.clear(accept);
    await userEvent.type(accept, "10");
    await create();
    expect(wait).toBeInvalid();
    expect(wait).toHaveAccessibleDescription(/from 30 to 7200 seconds/);
    expect(accept).toHaveAccessibleDescription(/from 30 to 600 seconds/);
    expect(screen.getByLabelText(/^Result TTL/)).toBeValid();
    expect(mockApi.createChannel).not.toHaveBeenCalled();
    // 600 s is fine deferred and too long live: the bounds are the mode's.
    await userEvent.clear(accept);
    await userEvent.type(accept, "120");
    await userEvent.clear(wait);
    await userEvent.type(wait, "601");
    await userEvent.selectOptions(screen.getByLabelText(/^Mode/), "live");
    await create();
    expect(screen.getByLabelText(/^Wait timeout/)).toHaveAccessibleDescription(
      /from 5 to 600 seconds/,
    );
    expect(mockApi.createChannel).not.toHaveBeenCalled();
  });

  it("shows a server refusal under the field it names", async () => {
    vi.mocked(mockApi.createChannel).mockRejectedValueOnce(
      refusal(
        "pushChannelId is not an active push channel of this project on the same auth channel",
        { reason: "push_channel_unusable" },
      ),
    );
    await open();
    await userEvent.selectOptions(screen.getByLabelText(/^Mode/), "deferred");
    const picker = await screen.findByLabelText(/^Push channel/);
    await waitFor(() => expect(options(picker)).toContain("push_1"));
    await userEvent.selectOptions(picker, "push_1");
    await create();
    await waitFor(() => expect(picker).toBeInvalid());
    expect(picker).toHaveAccessibleDescription(/Pick another, or none/);
    // Under the field only: the form's notice does not repeat the server's words.
    expect(screen.queryByText(/pushChannelId is not an active/)).toBeNull();

    vi.mocked(mockApi.createChannel).mockRejectedValueOnce(
      refusal("invalid config", [
        {
          path: "resultTtlSec",
          message: "resultTtlSec must be 60..3600 on a deferred channel",
        },
      ]),
    );
    await create();
    const ttl = screen.getByLabelText(/^Result TTL/);
    await waitFor(() => expect(ttl).toBeInvalid());
    expect(ttl).toHaveAccessibleDescription(/must be 60\.\.3600/);
    expect(picker).toBeValid();
  });
});

describe("match channel: page", () => {
  function open(c: Channel) {
    vi.mocked(mockApi.channel).mockResolvedValue(c);
    return mount(
      <Routes>
        <Route path="/channels/:id" element={<ChannelDetailPage />} />
      </Routes>,
      { client: mockApi, path: `/channels/${c.id}` },
    );
  }

  it("a live channel keeps its socket and says its mode", async () => {
    open(LIVE);
    expect(await screen.findByText(LIVE.wsUrl!)).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
    expect(
      screen.getByText(/Mode: live · party size 2 · wait 60s/),
    ).toHaveTextContent(/result: members only/);
    expect(screen.queryByLabelText("Ticket routes")).toBeNull();
    expect(screen.queryByText(/Push channel:/)).toBeNull();
  });

  it("a deferred channel shows the ticket routes, its fields and the linked push channel", async () => {
    open(DEFERRED);
    const routes = await screen.findByLabelText("Ticket routes");
    expect(routes.textContent).toBe(
      [
        "POST https://match-api.example.test/m/match_2/ticket",
        "GET https://match-api.example.test/m/match_2/ticket",
        "DELETE https://match-api.example.test/m/match_2/ticket",
        "POST https://match-api.example.test/m/match_2/accept",
        "POST https://match-api.example.test/m/match_2/decline",
      ].join("\n"),
    );
    for (const label of ["API base", "Ticket routes"])
      expect(
        screen.getByRole("button", { name: `Copy ${label}` }),
      ).toBeInTheDocument();
    expect(screen.queryByText("WebSocket URL")).toBeNull();
    // The two limits a client meets first: the stage throttle and the cooldown.
    expect(
      screen.getByText(/no faster than every few seconds/),
    ).toHaveTextContent(
      /throttled at 5 requests\/s per stage.*POST …\/ticket can answer 429 cooldown with details\.retryAfter/,
    );
    expect(screen.getByText("deferred")).toBeInTheDocument();
    expect(
      screen.getByText(/Mode: deferred · party size 4 · wait 900s/),
    ).toHaveTextContent(
      /accept window 45s · result TTL 1200s · on timeout: partial/,
    );
    // Named once the project's push channels load; the id either way.
    expect(await screen.findByRole("link", { name: "alerts" })).toHaveAttribute(
      "href",
      "/channels/push_1",
    );
    expect(mockApi.projectChannels).toHaveBeenCalledWith("prj_1", "push");
  });

  it("says so when the stage has no ticket host, and when nothing is linked", async () => {
    open({
      ...DEFERRED,
      apiBase: undefined,
      ticketUrl: undefined,
      config: { ...DEFERRED.config, pushChannelId: undefined },
    });
    expect(
      await screen.findByText(/no HTTP host on this stage/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Ticket routes")).toBeNull();
    expect(screen.getByText(/Push channel: none/)).toBeInTheDocument();
  });

  it("an edit shows the mode read-only and sends every deferred field back", async () => {
    vi.mocked(mockApi.updateChannel).mockResolvedValue(DEFERRED);
    open(DEFERRED);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const mode = within(dialog).getByLabelText(/^Mode/);
    expect(mode).toHaveValue("deferred");
    expect(mode).toBeDisabled();
    expect(mode).toHaveAccessibleDescription("Fixed at creation.");
    await waitFor(() =>
      expect(within(dialog).getByLabelText(/^Push channel/)).toHaveValue(
        "push_1",
      ),
    );
    const party = within(dialog).getByLabelText(/^Party size/);
    await userEvent.clear(party);
    await userEvent.type(party, "6");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateChannel).toHaveBeenCalledWith("match_2", {
        name: "league",
        config: { ...DEFERRED.config, partySize: 6 },
      }),
    );
  });

  it("an edit keeps a linked push channel it can no longer offer, and shows the refusal under it", async () => {
    vi.mocked(mockApi.updateChannel).mockRejectedValue(
      refusal(
        "pushChannelId is not an active push channel of this project on the same auth channel",
        { reason: "push_channel_unusable" },
      ),
    );
    open({
      ...DEFERRED,
      config: { ...DEFERRED.config, pushChannelId: "push_3" },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const picker = within(dialog).getByLabelText(/^Push channel/);
    await waitFor(() =>
      expect(options(picker)).toEqual(["", "push_1", "push_3"]),
    );
    expect(picker).toHaveValue("push_3");
    expect(
      within(picker).getByRole("option", { name: /push_3 — not usable/ }),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(picker).toBeInvalid());
    expect(vi.mocked(mockApi.updateChannel).mock.calls[0]?.[1]).toMatchObject({
      config: { pushChannelId: "push_3", acceptTimeoutSec: 45 },
    });
    // Still open, the message under the field and nowhere else.
    expect(
      within(dialog).queryByText(/pushChannelId is not an active/),
    ).toBeNull();
    // Clearing it is one choice away.
    vi.mocked(mockApi.updateChannel).mockResolvedValue(DEFERRED);
    await userEvent.selectOptions(picker, "");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mockApi.updateChannel).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(mockApi.updateChannel).mock.calls[1]?.[1].config,
    ).not.toHaveProperty("pushChannelId");
  });

  it("a live channel's edit sends no mode and no deferred field", async () => {
    vi.mocked(mockApi.updateChannel).mockResolvedValue(LIVE);
    open(LIVE);
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(/^Mode/)).toHaveValue("live");
    expect(within(dialog).queryByLabelText(/^Accept window/)).toBeNull();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateChannel).toHaveBeenCalledWith("match_1", {
        name: "duel",
        config: LIVE.config,
      }),
    );
  });
});

describe("match channel: lists", () => {
  it("names the mode in the kind cell, without a column of its own", async () => {
    vi.mocked(mockApi.channels).mockResolvedValue([AUTH, LIVE, DEFERRED]);
    mount(<ChannelsPage />, { client: mockApi, path: "/channels" });
    const cell = async (name: string) =>
      within(
        (await screen.findByRole("link", { name })).closest("tr")!,
      ).getAllByRole("cell")[1];
    expect(await cell("login")).toHaveTextContent(/^auth$/);
    expect(await cell("duel")).toHaveTextContent(/^match · live$/);
    expect(await cell("league")).toHaveTextContent(/^match · deferred$/);
    expect(
      screen.getAllByRole("columnheader").map((h) => h.textContent),
    ).toEqual([
      "Name",
      "Kind",
      "Project",
      "Id",
      "Status",
      "Expires",
      "Actions",
    ]);
  });
});
