import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type {
  LimitsView,
  TeamDetail,
  TracerAttachment,
  TracerDetail,
} from "../src/types";

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
  tracerIssues: vi.fn(),
  tracerEvents: vi.fn(),
  tracerEvent: vi.fn(),
  tracerTimeline: vi.fn(),
  tracerLogs: vi.fn(),
  tracerDrops: vi.fn(),
  tracerUsage: vi.fn(),
  tracerAttachment: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { TracerPage, TRACER_NO_BACKUP, TRACER_NOT_CONFIGURED } =
  await import("../src/pages/Tracer");
const { TracerEventPage } = await import("../src/pages/TracerEvent");
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
  vi.mocked(mockApi.tracerIssues).mockResolvedValue([]);
  vi.mocked(mockApi.tracerEvents).mockResolvedValue({ rows: [], next: null });
  vi.mocked(mockApi.tracerLogs).mockResolvedValue({ rows: [], next: null });
  vi.mocked(mockApi.tracerDrops).mockResolvedValue([]);
  vi.mocked(mockApi.tracerUsage).mockResolvedValue([]);
  vi.mocked(mockApi.tracerTimeline).mockResolvedValue({
    eventId: "e1",
    from: "",
    to: "",
    entries: [],
    truncated: false,
  });
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

describe("tracer data (decisions tracer #12)", () => {
  const ISSUE = {
    groupKey: "g1",
    title: "StateError: boom",
    level: "error",
    count: 3,
    firstSeen: "2026-11-08T06:42:15.991Z",
    lastSeen: "2026-11-08T06:42:15.991Z",
    latestEventId: "e1",
    status: "unresolved",
  };

  it("lists issues, and an issue opens its events", async () => {
    vi.mocked(mockApi.tracerIssues).mockResolvedValue([ISSUE]);
    vi.mocked(mockApi.tracerEvents).mockResolvedValue({
      rows: [
        {
          eventId: "e1",
          type: "event",
          received: ISSUE.lastSeen,
          title: "boom",
        },
      ],
      next: null,
    });
    open();
    const btn = await screen.findByRole("button", {
      name: /^StateError: boom, last seen .*: events$/,
    });
    expect(mockApi.tracerIssues).toHaveBeenCalledWith(ID, { since: "7d" });
    expect(
      screen.getByRole("link", {
        name: /^Open latest event: StateError: boom/,
      }),
    ).toHaveAttribute("href", `/tracers/${ID}/events/e1`);
    await userEvent.click(btn);
    expect(
      await screen.findByRole("link", { name: /^boom, received / }),
    ).toHaveAttribute("href", `/tracers/${ID}/events/e1`);
    expect(mockApi.tracerEvents).toHaveBeenLastCalledWith(ID, {
      since: "30d",
      group: "g1",
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Show every issue" }),
    );
    await waitFor(() =>
      expect(mockApi.tracerEvents).toHaveBeenLastCalledWith(ID, {
        since: "30d",
      }),
    );
  });

  it("filters logs from the URL and pages with the cursor", async () => {
    vi.mocked(mockApi.tracerLogs)
      .mockResolvedValueOnce({
        rows: [
          { received: "2026-11-08T06:42:15Z", level: "info", body: "first" },
        ],
        next: "c2",
      })
      .mockResolvedValue({
        rows: [
          { received: "2026-11-08T06:41:15Z", level: "info", body: "second" },
        ],
        next: null,
      });
    vi.mocked(mockApi.tracer).mockResolvedValue(TRACER);
    mount(
      <Routes>
        <Route path="/tracers/:id" element={<TracerPage />} />
      </Routes>,
      {
        client: mockApi,
        path: `/tracers/${ID}?tab=logs&level=error&attr=screen:home`,
      },
    );
    expect((await screen.findAllByText("first")).length).toBeGreaterThan(0);
    expect(mockApi.tracerLogs).toHaveBeenCalledWith(ID, {
      since: "1h",
      level: "error",
      attr: "screen:home",
    });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect((await screen.findAllByText("second")).length).toBeGreaterThan(0);
    expect(mockApi.tracerLogs).toHaveBeenLastCalledWith(ID, {
      since: "1h",
      level: "error",
      attr: "screen:home",
      cursor: "c2",
    });
  });

  it("says why a read failed", async () => {
    vi.mocked(mockApi.tracerIssues).mockRejectedValue(
      Object.assign(new Error("x"), {
        status: 503,
        details: { retryAfter: 60 },
      }),
    );
    open();
    expect(
      await screen.findByText(
        /Too many refused reads from this address; try again in 60 s/,
      ),
    ).toBeInTheDocument();
  });
});

describe("TracerEventPage: device data is untrusted", () => {
  const html = new TextEncoder().encode("<html><script>alert(1)</script>");
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
  ]);

  function openEvent(attachments: TracerAttachment[], extra: object = {}) {
    vi.mocked(mockApi.tracer).mockResolvedValue(TRACER);
    vi.mocked(mockApi.tracerEvent).mockResolvedValue({
      eventId: "e1",
      type: "event",
      received: "2026-11-08T06:43:00Z",
      title: "boom",
      message: "<img src=x onerror=alert(1)>",
      exception: [
        {
          type: "StateError",
          value: "bad",
          mechanism: { handled: false },
          frames: [
            { function: "main", filename: "main.dart", lineno: 3, inApp: true },
          ],
        },
      ],
      contexts: {
        links: { bad: "javascript:alert(1)", good: "https://example.com/a" },
      },
      attachments,
      ...extra,
    });
    return mount(
      <Routes>
        <Route
          path="/tracers/:id/events/:eventId"
          element={<TracerEventPage />}
        />
      </Routes>,
      { client: mockApi, path: `/tracers/${ID}/events/e1` },
    );
  }

  it("renders strings as text and links only http(s)", async () => {
    const { container } = openEvent([]);
    expect(
      await screen.findByText("<img src=x onerror=alert(1)>"),
    ).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("crash")).toBeInTheDocument();
    // Closed nodes render nothing until opened.
    expect(screen.queryByText('"javascript:alert(1)"')).toBeNull();
    await userEvent.click(screen.getByText("links"));
    expect(screen.queryByRole("link", { name: /javascript/ })).toBeNull();
    expect(screen.getByText('"javascript:alert(1)"')).toBeInTheDocument();
    const good = screen.getByRole("link", { name: "https://example.com/a" });
    expect(good).toHaveAttribute("rel", "noopener noreferrer");
    expect(mockApi.tracerTimeline).toHaveBeenCalledWith(ID, "e1", "2m");
    // Teams › team › project › tracer › event.
    const crumbs = (await screen.findByRole("link", { name: "game-debug" }))
      .parentElement!;
    expect(
      within(crumbs)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Teams", "studio", "dungeon", "game-debug"]);
  });

  it("shows a screenshot only when its bytes are an image", async () => {
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return `blob:${created.length}`;
    });
    URL.revokeObjectURL = vi.fn();
    vi.mocked(mockApi.tracerAttachment).mockImplementation((_id, att) =>
      Promise.resolve(att === "real" ? png : html),
    );
    openEvent([
      {
        id: "real",
        filename: "screenshot.png",
        contentType: "image/png",
        size: 10,
        sha256: "",
      },
      {
        id: "fake",
        filename: "screenshot-2.png",
        contentType: "image/png",
        size: 30,
        sha256: "",
      },
      {
        id: "svg",
        filename: "x.svg",
        contentType: "image/svg+xml",
        size: 30,
        sha256: "",
      },
    ]);
    expect(
      await screen.findByRole("img", { name: "Screenshot screenshot.png" }),
    ).toHaveAttribute("src", "blob:1");
    expect(created[0]!.type).toBe("image/png");
    expect(
      await screen.findByText(/Not an image after all/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show screenshot-2.png" }),
    ).toBeNull();
    expect(
      screen.queryByRole("img", { name: "Screenshot screenshot-2.png" }),
    ).toBeNull();
    // The svg is never fetched until asked, and then only as a download.
    expect(mockApi.tracerAttachment).not.toHaveBeenCalledWith(ID, "svg");
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await userEvent.click(
      screen.getByRole("button", { name: "Download x.svg" }),
    );
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(created.at(-1)!.type).toBe("application/octet-stream");
    click.mockRestore();
  });

  it("caps a huge view hierarchy and refuses an oversized one", async () => {
    let deep: object = { leaf: true };
    for (let i = 0; i < 200; i++) deep = { children: [deep] };
    const wide = { children: Array.from({ length: 20000 }, (_, i) => ({ i })) };
    vi.mocked(mockApi.tracerAttachment).mockImplementation((_id, att) =>
      Promise.resolve(
        new TextEncoder().encode(JSON.stringify(att === "deep" ? deep : wide)),
      ),
    );
    openEvent([
      {
        id: "deep",
        filename: "vh.json",
        attachmentType: "event.view_hierarchy",
        size: 5000,
        sha256: "",
      },
      {
        id: "wide",
        filename: "vh2.json",
        attachmentType: "event.view_hierarchy",
        size: 500000,
        sha256: "",
      },
      {
        id: "huge",
        filename: "vh3.json",
        attachmentType: "event.view_hierarchy",
        size: 3 * 1024 * 1024,
        sha256: "",
      },
    ]);
    const buttons = await screen.findAllByRole("button", {
      name: /^Show view hierarchy /,
    });
    for (const b of buttons) await userEvent.click(b);
    expect(
      (await screen.findAllByText(/not shown: too deep or too large/)).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText(/more not shown/)).toBeInTheDocument();
    // The wide one stops at its node budget (5000), not at 20000 rows.
    expect(
      document.querySelectorAll(".yyt-json-tree div").length,
    ).toBeLessThanOrEqual(5000);
    expect(screen.getByText(/Too large to show here/)).toBeInTheDocument();
    expect(mockApi.tracerAttachment).not.toHaveBeenCalledWith(ID, "huge");
  });
});
