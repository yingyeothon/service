import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { Member } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  members: vi.fn(),
  memberAction: vi.fn(),
  installerApp: vi.fn(),
  setInstallerApp: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { MembersPage } = await import("../src/pages/Members");
const { mount } = await import("./wrap");

const MEMBERS: Member[] = [
  {
    id: "u1",
    login: "alice",
    role: "admin",
    createdAt: 0,
    approvedAt: 0,
    approvedBy: null,
  },
  {
    id: "u2",
    login: "bob",
    role: "member",
    createdAt: 0,
    approvedAt: 0,
    approvedBy: "alice",
  },
  {
    id: "u3",
    login: "carol",
    role: "pending",
    createdAt: 0,
    approvedAt: null,
    approvedBy: null,
  },
];

describe("MembersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "admin",
      via: "session",
    });
    vi.mocked(mockApi.members).mockResolvedValue(MEMBERS);
    vi.mocked(mockApi.installerApp).mockResolvedValue({
      appId: null,
      appName: null,
      teamId: null,
      teamName: null,
      trusted: false,
      updatedAt: null,
    });
  });

  it("lists members, marks the caller and counts the sign-ups waiting", async () => {
    mount(<MembersPage />, { client: mockApi });
    expect(await screen.findByText("carol")).toBeInTheDocument();
    for (const col of ["Login", "Role", "Signed up", "Approved"])
      expect(
        screen.getByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
    expect(screen.getByText("(you)")).toBeInTheDocument();
    expect(
      screen.getByText("1 sign-up waiting for approval."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Not set: the downloads route answers 503."),
    ).toBeInTheDocument();
  });

  it("approves a pending member with one click and never demotes the caller", async () => {
    vi.mocked(mockApi.memberAction).mockResolvedValue({} as never);
    mount(<MembersPage />, { client: mockApi });
    await screen.findByText("carol");
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(mockApi.memberAction).toHaveBeenCalledWith("u3", "approve"),
    );
    // alice (admin, the caller) has no menu; bob's menu promotes after a confirm.
    expect(
      screen.queryByRole("button", { name: "Actions for alice" }),
    ).toBeNull();
    vi.mocked(mockApi.memberAction).mockClear();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for bob" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Promote to admin" }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Promote" }),
    );
    await waitFor(() =>
      expect(mockApi.memberAction).toHaveBeenCalledWith("u2", "promote"),
    );
  });

  it("sets the installer app", async () => {
    vi.mocked(mockApi.setInstallerApp).mockResolvedValue({
      appId: "ca_1",
      appName: "console",
      teamId: "team_1",
      teamName: "ops",
      trusted: true,
      updatedAt: 1,
    });
    mount(<MembersPage />, { client: mockApi });
    await screen.findByText("carol");
    await userEvent.type(screen.getByLabelText("Catalog app id"), "ca_1");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mockApi.setInstallerApp).toHaveBeenCalledWith("ca_1"),
    );
    expect(await screen.findByText("trusted")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ops" })).toHaveAttribute(
      "href",
      "/teams/team_1",
    );
  });
});
