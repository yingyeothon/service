import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../src/api";
import type { ApiToken } from "../src/types";

const mockApi = {
  me: vi.fn(),
  logout: vi.fn(),
  loginUrl: vi.fn(() => "/auth/github/start"),
  setUnauthorizedHandler: vi.fn(),
  tokens: vi.fn(),
  createToken: vi.fn(),
  revokeToken: vi.fn(),
} as unknown as ApiClient;

vi.mock("../src/api", () => ({
  api: mockApi,
  ApiError: class extends Error {},
}));

const { TokensPage } = await import("../src/pages/Tokens");
const { mount } = await import("./wrap");

const TOKENS: ApiToken[] = [
  { id: "tok_1", name: "laptop", createdAt: 0, lastUsedAt: null },
];

describe("TokensPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockApi.me).mockResolvedValue({
      id: "u1",
      login: "alice",
      role: "member",
      via: "session",
    });
    vi.mocked(mockApi.tokens).mockResolvedValue(TOKENS);
  });

  it("lists tokens with their columns and the CLI hint", async () => {
    mount(<TokensPage />, { client: mockApi });
    expect(
      await screen.findByRole("heading", { name: "API tokens" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("laptop")).toBeInTheDocument();
    for (const col of ["Name", "Id", "Created", "Last used"])
      expect(
        screen.getByRole("columnheader", { name: col }),
      ).toBeInTheDocument();
    expect(screen.getByText(/yyt login --api/)).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    vi.mocked(mockApi.tokens).mockResolvedValue([]);
    mount(<TokensPage />, { client: mockApi });
    expect(await screen.findByText("No tokens yet.")).toBeInTheDocument();
  });

  it("creates a token and shows the secret once", async () => {
    vi.mocked(mockApi.createToken).mockResolvedValue({
      id: "tok_2",
      name: "phone",
      token: "yyt_secret",
      createdAt: 0,
      lastUsedAt: null,
    });
    mount(<TokensPage />, { client: mockApi });
    await screen.findByText("laptop");
    await userEvent.type(screen.getByLabelText("Token name"), "phone");
    await userEvent.click(screen.getByRole("button", { name: "Create token" }));
    await waitFor(() =>
      expect(mockApi.createToken).toHaveBeenCalledWith("phone"),
    );
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("yyt_secret")).toBeInTheDocument();
    await userEvent.click(
      within(banner).getByRole("button", { name: "I have copied it" }),
    );
    expect(screen.queryByText("yyt_secret")).toBeNull();
  });

  it("revokes after a confirmation", async () => {
    vi.mocked(mockApi.revokeToken).mockResolvedValue(undefined);
    mount(<TokensPage />, { client: mockApi });
    await screen.findByText("laptop");
    await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mockApi.revokeToken).toHaveBeenCalledWith("tok_1"),
    );
  });
});
