import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

const createToken = vi.fn();
vi.mock("../src/api", () => ({ api: { createToken } }));
vi.mock("../src/lib/query", () => ({
  useAction: () => ({
    busy: false,
    error: null,
    run: async (fn: () => Promise<unknown>) => fn(),
  }),
}));
vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,QQ==") },
}));

const { AppLoginPage, appLoginPayload } = await import("../src/pages/AppLogin");
const { theme } = await import("../src/theme");

describe("AppLoginPage", () => {
  it("encodes the token and origin the app expects", () => {
    expect(JSON.parse(appLoginPayload("yyt_x", "https://c.example"))).toEqual({
      type: "yyt_api_key",
      apiKey: "yyt_x",
      server: "https://c.example",
    });
  });

  it("mints a token and renders it as a QR image", async () => {
    createToken.mockResolvedValue({ id: "t1", name: "app x", token: "yyt_x" });
    render(
      <MantineProvider theme={theme} forceColorScheme="light">
        <MemoryRouter>
          <AppLoginPage />
        </MemoryRouter>
      </MantineProvider>,
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Show login QR/ }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("img", { name: "App login QR code" }),
      ).toBeTruthy(),
    );
    expect(createToken).toHaveBeenCalledWith(expect.stringMatching(/^app /));
    expect(screen.queryByText("yyt_x")).toBeNull();
  });
});
