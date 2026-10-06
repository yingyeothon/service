import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { Channel, ProjectDetail, TeamDetail } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  project: vi.fn(),
  projectChannels: vi.fn(),
  createChannel: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { ChannelNewPage } = await import("../src/pages/ChannelNew");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
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

function open() {
  return mount(
    <Routes>
      <Route
        path="/teams/:team/projects/:prj/channels/new"
        element={<ChannelNewPage />}
      />
    </Routes>,
    { client: mockApi, path: "/teams/team_1/projects/prj_1/channels/new" },
  );
}

describe("ChannelNewPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.team).mockResolvedValue(TEAM);
    vi.mocked(mockApi.project).mockResolvedValue(PROJECT);
    vi.mocked(mockApi.projectChannels).mockResolvedValue([]);
  });

  it("offers the six kinds and cancels back to the project's channels", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "New channel" }),
    ).toBeInTheDocument();
    const kind = await screen.findByLabelText("Kind");
    expect(kind).toBeInTheDocument();
    expect(
      screen.getAllByRole<HTMLOptionElement>("option").map((o) => o.value),
    ).toEqual(["auth", "topic", "match", "lobby", "q", "push"]);
    expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute(
      "href",
      "/teams/team_1/projects/prj_1/channels",
    );
    expect(screen.getByRole("link", { name: "dungeon" })).toHaveAttribute(
      "href",
      "/teams/team_1/projects/prj_1",
    );
  });

  it("refuses a topic channel while the project has no auth channel", async () => {
    open();
    await screen.findByRole("heading", { name: "New channel" });
    await userEvent.selectOptions(
      await screen.findByLabelText("Kind"),
      "topic",
    );
    await waitFor(() =>
      expect(mockApi.projectChannels).toHaveBeenCalledWith("prj_1", "auth"),
    );
    expect(
      await screen.findByText(/need an auth channel in this project/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create channel" }),
    ).toBeDisabled();
    await userEvent.click(
      screen.getByRole("button", { name: "Create an auth channel" }),
    );
    expect(screen.getByLabelText("Kind")).toHaveValue("auth");
  });

  it("is read-only for a seatless admin", async () => {
    vi.mocked(mockApi.team).mockResolvedValue({ ...TEAM, role: "admin" });
    open();
    await screen.findByRole("heading", { name: "New channel" });
    expect(await screen.findByText(/Read-only/)).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Create channel" }),
    ).toBeDisabled();
  });

  describe("push", () => {
    const AUTH: Channel = {
      id: "auth_1",
      kind: "auth",
      name: "login",
      teamId: "team_1",
      teamName: "studio",
      projectId: "prj_1",
      projectName: "dungeon",
      createdBy: "alice",
      config: {
        audience: "game",
        tokenTtlSec: 3600,
        redirectAllowlist: [],
        providers: {},
      },
      createdAt: 0,
      expiresAt: 1,
      disabledAt: null,
      status: "active",
    };
    // Not a key: only that it is sent, and never rendered, matters here.
    const KEY = '{"type":"service_account","project_id":"team-proj"}';
    const refusal = (status: number, details: unknown) =>
      Object.assign(new Error("refused"), { status, details });

    /** The push form, filled up to the package name. */
    async function fill(packageName: string) {
      vi.mocked(mockApi.projectChannels).mockResolvedValue([AUTH]);
      open();
      await userEvent.selectOptions(
        await screen.findByLabelText("Kind"),
        "push",
      );
      await userEvent.type(screen.getByLabelText(/^Name/), "alerts");
      await userEvent.selectOptions(
        await screen.findByLabelText(/^Auth channel/),
        "auth_1",
      );
      await userEvent.type(screen.getByLabelText(/^Package name/), packageName);
    }
    const create = () =>
      userEvent.click(screen.getByRole("button", { name: "Create channel" }));

    it("checks the package grammar before any request, then creates on the platform sender", async () => {
      vi.mocked(mockApi.createChannel).mockResolvedValue({
        ...AUTH,
        id: "push_1",
        kind: "push",
        apiKey: "k",
      });
      await fill("game");
      expect(screen.getByLabelText(/^Sender/)).toHaveValue("platform");
      expect(screen.queryByLabelText(/^Service-account key/)).toBeNull();
      await create();
      const field = screen.getByLabelText(/^Package name/);
      expect(field).toBeInvalid();
      expect(field).toHaveAccessibleDescription(/two or more dot-separated/);
      expect(mockApi.createChannel).not.toHaveBeenCalled();

      await userEvent.clear(field);
      await userEvent.type(field, "com.example.game");
      await create();
      await waitFor(() =>
        expect(mockApi.createChannel).toHaveBeenCalledWith("prj_1", {
          kind: "push",
          name: "alerts",
          config: {
            authChannelId: "auth_1",
            packageName: "com.example.game",
            sender: "platform",
          },
        }),
      );
    });

    it("takes the team sender's key in a masked field and sends it once", async () => {
      vi.mocked(mockApi.createChannel).mockResolvedValue({
        ...AUTH,
        id: "push_1",
        kind: "push",
        apiKey: "k",
      });
      await fill("com.example.game");
      await userEvent.selectOptions(screen.getByLabelText(/^Sender/), "team");
      await create();
      const key = screen.getByLabelText(/^Service-account key/);
      expect(key).toHaveAttribute("type", "password");
      expect(key).toBeInvalid();
      expect(mockApi.createChannel).not.toHaveBeenCalled();

      await userEvent.click(key);
      await userEvent.paste(KEY);
      await create();
      await waitFor(() =>
        expect(mockApi.createChannel).toHaveBeenCalledWith("prj_1", {
          kind: "push",
          name: "alerts",
          config: {
            authChannelId: "auth_1",
            packageName: "com.example.game",
            sender: "team",
            teamServiceAccount: KEY,
          },
        }),
      );
      expect(screen.queryByText(KEY, { exact: false })).toBeNull();
    });

    it("reads the key from a picked file and acknowledges its length only", async () => {
      await fill("com.example.game");
      await userEvent.selectOptions(screen.getByLabelText(/^Sender/), "team");
      const file = new File([`${KEY}\n`], "team-proj-adminsdk.json", {
        type: "application/json",
      });
      await userEvent.upload(screen.getByLabelText("Choose key file"), file);
      expect(
        await screen.findByText(`Key file loaded (${KEY.length} characters).`),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/^Service-account key/)).toHaveValue(KEY);
      expect(screen.queryByText(/team-proj-adminsdk/)).toBeNull();
    });

    it("shows a package or key refusal under its field", async () => {
      vi.mocked(mockApi.createChannel).mockRejectedValueOnce(
        refusal(409, { reason: "package_taken" }),
      );
      await fill("com.example.game");
      await create();
      const field = screen.getByLabelText(/^Package name/);
      await waitFor(() => expect(field).toBeInvalid());
      expect(field).toHaveAccessibleDescription(
        /already registered on this stage/,
      );
      // Under the field only: no general notice repeats it.
      expect(
        screen.getAllByText(/already registered on this stage/),
      ).toHaveLength(1);

      vi.mocked(mockApi.createChannel).mockRejectedValueOnce(
        refusal(400, { reason: "service_account", field: "client_email" }),
      );
      await userEvent.selectOptions(screen.getByLabelText(/^Sender/), "team");
      await userEvent.click(screen.getByLabelText(/^Service-account key/));
      await userEvent.paste(KEY);
      await create();
      const key = screen.getByLabelText(/^Service-account key/);
      await waitFor(() => expect(key).toBeInvalid());
      expect(key).toHaveAccessibleDescription(
        /client_email is missing or malformed/,
      );
      expect(screen.getByLabelText(/^Package name/)).toBeValid();
    });

    it("points the team cap at the team's limits", async () => {
      vi.mocked(mockApi.createChannel).mockRejectedValue(
        refusal(409, { limit: "push.appsPerTeam", value: 2 }),
      );
      await fill("com.example.game");
      await create();
      const alert = (
        await screen.findByText(
          /already has 2 push apps on the platform sender/,
        )
      ).closest('[role="alert"]');
      expect(alert).toHaveTextContent(/A team-sender channel does not count/);
      expect(
        screen.getByRole("link", { name: "Limits on the team page" }),
      ).toHaveAttribute("href", "/teams/team_1/projects");
      // Switching the kind drops a refusal that was about push.
      await userEvent.selectOptions(screen.getByLabelText("Kind"), "topic");
      expect(screen.queryByText(/already has 2 push apps/)).toBeNull();
    });

    it.each([
      ["push_not_configured", /Push is not set up on this stage/],
      ["push_pool_full", /no registration slot is free/],
      ["firebase_unavailable", /Firebase did not answer the platform/],
    ])("explains %s as a platform-side condition", async (reason, text) => {
      vi.mocked(mockApi.createChannel).mockRejectedValue(
        refusal(503, { reason }),
      );
      await fill("com.example.game");
      await create();
      const alert = (await screen.findByText(text)).closest('[role="alert"]');
      expect(alert).toHaveTextContent(/Nothing in the form is wrong/);
      expect(screen.getByLabelText(/^Package name/)).toBeValid();
    });
  });
});
