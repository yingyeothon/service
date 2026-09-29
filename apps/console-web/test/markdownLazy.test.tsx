import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { theme } from "../src/theme";

// Pins the chunk split: importing `Markdown` must not load react-markdown;
// only rendering it does (through the lazy `MarkdownBody`). Nothing in this
// file may import `MarkdownBody` statically.
const { rendererLoaded, failNext } = vi.hoisted(() => ({
  rendererLoaded: vi.fn(),
  failNext: { value: false },
}));
vi.mock("react-markdown", async (orig) => {
  rendererLoaded();
  if (failNext.value) throw new Error("chunk failed");
  return orig();
});
const { Markdown } = await import("../src/components/Markdown");

function md(text: string) {
  return render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <Markdown text={text} />
    </MantineProvider>,
  ).container;
}

describe("Markdown (lazy wrapper)", () => {
  // The two "not loaded yet" assertions below rely on running first: a case
  // that renders the body earlier in this file would (loudly) break them.
  it("renders nothing for a blank body without loading the renderer", () => {
    expect(md(" \n ").querySelector(".markdown")).toBeNull();
    expect(rendererLoaded).not.toHaveBeenCalled();
  });

  it("shows the raw text until the renderer chunk lands, then the markup", async () => {
    expect(rendererLoaded).not.toHaveBeenCalled();
    md("**bold** text");
    expect(screen.getByText("**bold** text")).toBeInTheDocument();
    expect(
      await screen.findByText("bold", { selector: "strong" }),
    ).toBeInTheDocument();
    expect(rendererLoaded).toHaveBeenCalled();
  });

  it("keeps the raw text when the renderer chunk fails to load", async () => {
    vi.resetModules();
    failNext.value = true;
    const { Markdown: Fresh } = await import("../src/components/Markdown");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <MantineProvider theme={theme} forceColorScheme="light">
          <Fresh text="**lost** chunk" />
        </MantineProvider>,
      );
      // The boundary's fallback is the same plain text as the Suspense one.
      expect(await screen.findByText("**lost** chunk")).toBeInTheDocument();
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.getByText("**lost** chunk")).toBeInTheDocument();
      expect(screen.queryByText("lost", { selector: "strong" })).toBeNull();
    } finally {
      failNext.value = false;
      err.mockRestore();
    }
  });
});
