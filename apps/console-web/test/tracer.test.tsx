import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { LimitsView, TeamDetail, TracerDetail } from "../src/types";

/*
 * The tracer resource page (`/tracers/:id`): the DSN and write key a debug
 * build needs, the no-backup notice, rotate and delete behind a confirm, the
 * daily-bytes limit, and the PATCH body (only what changed).
 */

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  team: vi.fn(),
  limits: vi.fn(),
  tracer: vi.fn(),
  updateTracer: vi.fn(),
  rotateTracerKey: vi.fn(),
  deleteTracer: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { TracerPage, TRACER_NO_BACKUP, TRACER_NOT_CONFIGURED } =
  await import("../src/pages/Tracer");
const { mount } = await import("./wrap");

const TEAM: TeamDetail = { id: "team_1", name: "studio", role: "member" };
const KEY = "0123456789abcdef0123456789abcdef";
const ID = "trc_01hf7yavygfgdxpjfmr5r0g6ca";
const TRACER: TracerDetail = {
  id: ID,
  name: "game-debug",
  description: "debug builds",
  teamId: "team_1",
  teamName: "studio",
  projectId: "prj_1",
  projectName: "dungeon",
  createdBy: "alice",
  writeKey: KEY,
  dsn: `https://${KEY}@trace.example/${ID}`,
  readUrl: "https://trace.example",
  noBackup: true,
  createdAt: 0,
  updatedAt: 0,
};
const MiB = 1024 * 1024;
const LIMITS: LimitsView = {
  scope: { kind: "tracer", id: ID },
  teamId: "team_1",
  limits: [
    {
      key: "tracer.dailyBytes",
      unit: "bytes",
      soft: 50 * MiB,
      hard: 300 * MiB,
      effective: 50 * MiB,
      usage: null,
      step: 50 * MiB,
      next: null,
      override: null,
    },
  ],
  pending: [],
};

function open(t: TracerDetail = TRACER) {
  vi.mocked(mockApi.tracer).mockResolvedValue(t);
  return mount(
    <Routes>
      <Route path="/tracers/:id" element={<TracerPage />} />
      <Route
        path="/teams/:team/projects/:prj/:tab"
        element={<p>project tab</p>}
      />
    </Routes>,
    { client: mockApi, path: `/tracers/${ID}` },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mockApi.limits).mockResolvedValue(LIMITS);
  vi.mocked(mockApi.me).mockResolvedValue({
    id: "u1",
    login: "alice",
    role: "member",
    via: "session",
  });
  vi.mocked(mockApi.team).mockResolvedValue(TEAM);
});

describe("TracerPage", () => {
  it("shows the DSN, the write key, the no-backup notice and how to read", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "game-debug" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "dungeon" })).toHaveAttribute(
      "href",
      "/teams/team_1/projects/prj_1",
    );
    expect(screen.getByText(TRACER_NO_BACKUP)).toBeInTheDocument();
    expect(screen.getByText(TRACER.dsn!)).toBeInTheDocument();
    expect(screen.getByText(KEY)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy DSN" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy Write key" }),
    ).toBeInTheDocument();
    // The id, not the name: a shell has no project context to resolve it.
    expect(screen.getByLabelText("Commands").textContent).toContain(
      `yyt tracer issues ${ID} --since 1h`,
    );
    expect(screen.getAllByText("tracer-debug").length).toBeGreaterThan(0);
    // Limits: the tracer scope, usage unknown while tracer does not answer.
    expect(mockApi.limits).toHaveBeenCalledWith(`tracer:${ID}`);
    expect(await screen.findByText("Daily debug data")).toBeInTheDocument();
    expect(
      screen.getByText(/yyt limit request --tracer/).textContent,
    ).toContain(`--tracer ${ID} tracer.dailyBytes +50MiB`);
  });

  it("says when the stage has no tracer, instead of a DSN", async () => {
    open({ ...TRACER, dsn: null, readUrl: null });
    await screen.findByRole("heading", { name: "game-debug" });
    expect(screen.getByText(TRACER_NOT_CONFIGURED)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy DSN" })).toBeNull();
    // Nothing to rotate while no build can carry the key.
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(screen.queryByLabelText("Commands")).toBeNull();
    expect(screen.getByText(/until tracer is configured/)).toBeInTheDocument();
  });

  it("rotates the key only after a confirmation and shows the new one", async () => {
    const NEW = "f".repeat(32);
    vi.mocked(mockApi.rotateTracerKey).mockResolvedValue({
      ...TRACER,
      writeKey: NEW,
      dsn: `https://${NEW}@trace.example/${ID}`,
    });
    open();
    const rotateItem = async () => {
      await userEvent.click(
        await screen.findByRole("button", { name: "More actions" }),
      );
      await userEvent.click(
        await screen.findByRole("menuitem", { name: "Rotate key" }),
      );
    };
    await rotateItem();
    const modal = await screen.findByRole("dialog");
    expect(
      within(modal).getByText(/refused within about a minute/),
    ).toBeInTheDocument();
    await userEvent.click(
      within(modal).getByRole("button", { name: "Cancel" }),
    );
    expect(mockApi.rotateTracerKey).not.toHaveBeenCalled();
    await rotateItem();
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Rotate key",
      }),
    );
    await waitFor(() =>
      expect(mockApi.rotateTracerKey).toHaveBeenCalledWith(ID),
    );
    expect(await screen.findByText(NEW)).toBeInTheDocument();
    expect(screen.queryByText(KEY)).toBeNull();
  });

  it("saves only the changed fields; a cleared description is null", async () => {
    vi.mocked(mockApi.updateTracer).mockResolvedValue({
      ...TRACER,
      name: "game-dbg",
      description: null,
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    const name = within(drawer).getByLabelText(/^Name/);
    await userEvent.clear(name);
    await userEvent.type(name, "game-dbg");
    await userEvent.clear(within(drawer).getByLabelText(/^Description/));
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.updateTracer).toHaveBeenCalledWith(ID, {
        name: "game-dbg",
        description: null,
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "game-dbg" }),
    ).toBeInTheDocument();
  });

  it("closes an untouched edit without a request", async () => {
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(within(drawer).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockApi.updateTracer).not.toHaveBeenCalled();
  });

  it("deletes from the drawer danger zone and returns to the project's tracers tab", async () => {
    vi.mocked(mockApi.deleteTracer).mockResolvedValue(undefined);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText(/7-day grace/)).toBeInTheDocument();
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Delete tracer resource" }),
    );
    const modal = (await screen.findByText("Delete tracer resource?")).closest(
      '[role="dialog"]',
    ) as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete tracer resource" }),
    );
    await waitFor(() => expect(mockApi.deleteTracer).toHaveBeenCalledWith(ID));
    expect(await screen.findByText("project tab")).toBeInTheDocument();
  });

  it("shows the server's refusal (a seatless admin is refused the page)", async () => {
    vi.mocked(mockApi.tracer).mockRejectedValue(
      new Error("a platform admin without a seat cannot open this"),
    );
    mount(
      <Routes>
        <Route path="/tracers/:id" element={<TracerPage />} />
      </Routes>,
      { client: mockApi, path: `/tracers/${ID}` },
    );
    expect(
      await screen.findByText(/without a seat cannot open this/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
  });
});
