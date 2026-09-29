import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { AuditDetail, AuditRow } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  audit: vi.fn(),
  auditRow: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { AuditPage } = await import("../src/pages/Audit");
const { mount } = await import("./wrap");

const ROW: AuditRow = {
  id: "au_1",
  actor: "alice",
  action: "show.delete",
  target: "show_1",
  at: 1_700_000_000_000,
};
const DETAIL: AuditDetail = {
  ...ROW,
  detail: '{"reason":"spam"}',
  detailTruncated: true,
};

describe("AuditPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.audit).mockResolvedValue({ rows: [ROW], next: null });
    vi.mocked(mockApi.auditRow).mockResolvedValue(DETAIL);
  });

  it("lists rows, applies the free-text filter and pages with the applied one", async () => {
    vi.mocked(mockApi.audit).mockImplementation((f) =>
      f?.cursor
        ? Promise.resolve({ rows: [{ ...ROW, id: "au_2" }], next: null })
        : Promise.resolve({ rows: [ROW], next: "c1" }),
    );
    mount(<AuditPage />, { client: mockApi });
    for (const col of ["When", "Action", "Actor", "Target"])
      expect(
        await screen.findByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
    expect(await screen.findByText("show.delete")).toBeInTheDocument();
    expect(mockApi.audit).toHaveBeenCalledWith({
      actionPrefix: undefined,
      actor: undefined,
      target: undefined,
      cursor: undefined,
    });
    // Blank inputs are omitted; Load more reuses the applied filter.
    await userEvent.type(screen.getByLabelText("Action starts with"), "show.");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(mockApi.audit).toHaveBeenLastCalledWith({
        actionPrefix: "show.",
        actor: undefined,
        target: undefined,
        cursor: undefined,
      }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Load more" }),
    );
    await waitFor(() =>
      expect(mockApi.audit).toHaveBeenLastCalledWith({
        actionPrefix: "show.",
        actor: undefined,
        target: undefined,
        cursor: "c1",
      }),
    );
    expect(await screen.findAllByText("show.delete")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("opens a row's detail in a read-only drawer", async () => {
    mount(<AuditPage />, { client: mockApi });
    await userEvent.click(
      await screen.findByRole("button", { name: /^Detail of show\.delete/ }),
    );
    await waitFor(() => expect(mockApi.auditRow).toHaveBeenCalledWith("au_1"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "show.delete" }),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/alice ·/)).toBeInTheDocument();
    expect(within(dialog).getByText('{"reason":"spam"}')).toBeInTheDocument();
    expect(within(dialog).getByText(/Shortened:/)).toBeInTheDocument();
    // Nothing renders below the table: the drawer is the only detail surface.
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });
});
