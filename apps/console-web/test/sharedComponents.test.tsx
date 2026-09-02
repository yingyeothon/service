import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { DropZone } from "../src/components/ui";
import { fmtTime, formatLocal } from "../src/lib/format";
import { toLocalInput } from "../src/lib/eventForm";
import { theme } from "../src/theme";

/*
 * The click-or-drop target the uploaders share, and the date helpers. The
 * form furniture that used to be pinned here (name/description cards, the
 * submit row, the danger card, the link cell) was retired for the page
 * grammar kit, whose contract lives in `kit.test.tsx`.
 */

function mount(node: React.ReactNode) {
  return render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <MemoryRouter>{node}</MemoryRouter>
    </MantineProvider>,
  );
}

describe("DropZone", () => {
  const files = [new File(["a"], "a.zip", { type: "application/zip" })];
  const zone = (props: Partial<Parameters<typeof DropZone>[0]> = {}) => {
    const onFiles = vi.fn<(files: FileList | null) => void>();
    mount(
      <DropZone
        label="Choose or drop the build zip"
        onFiles={onFiles}
        {...props}
      >
        caption
      </DropZone>,
    );
    const el = screen.getByRole("button", {
      name: "Choose or drop the build zip",
    });
    const file = el.querySelector<HTMLInputElement>("input[type=file]")!;
    return { el, file, onFiles };
  };

  it("is a focusable button that opens the hidden input on click, Enter and Space", async () => {
    const { el, file } = zone();
    expect(el).toHaveAttribute("tabindex", "0");
    expect(file).toHaveAttribute("hidden");
    const click = vi.spyOn(file, "click").mockImplementation(() => {});
    await userEvent.click(el);
    expect(click).toHaveBeenCalledTimes(1);
    el.focus();
    await userEvent.keyboard("{Enter}");
    expect(click).toHaveBeenCalledTimes(2);
    await userEvent.keyboard(" ");
    expect(click).toHaveBeenCalledTimes(3);
    await userEvent.keyboard("a");
    expect(click).toHaveBeenCalledTimes(3);
  });

  it("hands dropped and chosen files to onFiles", () => {
    const { el, file, onFiles } = zone();
    fireEvent.drop(el, { dataTransfer: { files } });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(Array.from(onFiles.mock.calls[0]![0]!)).toEqual(files);
    fireEvent.change(file, { target: { files } });
    expect(onFiles).toHaveBeenCalledTimes(2);
    expect(Array.from(onFiles.mock.calls[1]![0]!)).toEqual(files);
  });

  it("forwards accept and multiple to the input and dims the caption on request", () => {
    const { file } = zone({ accept: ".zip,application/zip", multiple: true });
    expect(file).toHaveAttribute("accept", ".zip,application/zip");
    expect(file).toHaveAttribute("multiple");
    expect(screen.getByText("caption")).not.toHaveStyle({
      color: "var(--mantine-color-dimmed)",
    });
  });

  it("dims the caption while nothing is chosen", () => {
    zone({ dimmed: true });
    expect(screen.getByText("caption")).toHaveStyle({
      color: "var(--mantine-color-dimmed)",
    });
  });

  it("defaults to a single file with no accept filter", () => {
    const { file } = zone();
    expect(file).not.toHaveAttribute("accept");
    expect(file).not.toHaveAttribute("multiple");
  });
});

describe("formatLocal", () => {
  // Noon UTC on 2026-03-04 is the same calendar day in every zone from -12 to +11.
  const sec = Date.UTC(2026, 2, 4, 12, 0) / 1000;
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const ymd = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;

  it("keeps the display and input forms apart by separator and empty value", () => {
    expect(fmtTime(sec)).toBe(`${ymd} ${hm}`);
    expect(toLocalInput(sec)).toBe(`${ymd}T${hm}`);
    expect(formatLocal(sec, "|", "")).toBe(`${ymd}|${hm}`);
    expect(fmtTime(null)).toBe("—");
    expect(fmtTime(undefined)).toBe("—");
    expect(toLocalInput(null)).toBe("");
    expect(toLocalInput(undefined)).toBe("");
    expect(fmtTime(0)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
