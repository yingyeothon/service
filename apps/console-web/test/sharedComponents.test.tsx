import { MantineProvider, Table } from "@mantine/core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  DraftForm,
  ResourceInfoForm,
  SettingsForm,
} from "/home/lacti/git/yyt.life/service/apps/console-web/src/components/ResourceForms";
import {
  DangerCard,
  DropZone,
  FormActions,
  LinkCell,
} from "/home/lacti/git/yyt.life/service/apps/console-web/src/components/ui";
import {
  fmtTime,
  formatLocal,
} from "/home/lacti/git/yyt.life/service/apps/console-web/src/lib/format";
import { toLocalInput } from "/home/lacti/git/yyt.life/service/apps/console-web/src/lib/eventForm";
import { theme } from "/home/lacti/git/yyt.life/service/apps/console-web/src/theme";

/*
 * The shared form pieces the resource pages moved onto. The bundle, site and
 * catalog-app pages, the discussion page and the comment form have no page
 * test, so their contract is pinned here, on the components themselves.
 */

function mount(node: React.ReactNode) {
  return render(
    <MantineProvider theme={theme} forceColorScheme="light">
      <MemoryRouter>{node}</MemoryRouter>
    </MantineProvider>,
  );
}

const input = (label: string) =>
  screen.getByLabelText<HTMLInputElement>(new RegExp(`^${label}`));
const submitted = () => {
  const onSubmit = vi.fn(async (e: { preventDefault: () => void }) => {
    e.preventDefault();
  });
  return onSubmit;
};

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

describe("ResourceInfoForm", () => {
  const form = (busy = false) => {
    const onSubmit = submitted();
    const onName = vi.fn();
    const onDescription = vi.fn();
    mount(
      <ResourceInfoForm
        name="game"
        description="desc"
        onName={onName}
        onDescription={onDescription}
        onSubmit={onSubmit}
        busy={busy}
      />,
    );
    return { onSubmit, onName, onDescription };
  };

  it("has an optional name (64) and description (2000) at the inline widths", () => {
    form();
    const name = input("Name");
    const desc = input("Description");
    expect(name).toHaveValue("game");
    expect(name.maxLength).toBe(64);
    expect(name.required).toBe(false);
    expect(desc).toHaveValue("desc");
    expect(desc.maxLength).toBe(2000);
    // Mantine turns `w={200}` into rem: 200 / 16 = 12.5.
    expect(name.closest(".mantine-TextInput-root")).toHaveStyle({
      width: "calc(12.5rem * var(--mantine-scale))",
    });
    expect(desc.closest(".mantine-TextInput-root")).toHaveStyle({
      width: "calc(17.5rem * var(--mantine-scale))",
    });
  });

  it("reports edits and submits with Save", async () => {
    const { onSubmit, onName, onDescription } = form();
    await userEvent.type(input("Name"), "s");
    expect(onName).toHaveBeenLastCalledWith("games");
    await userEvent.type(input("Description"), "!");
    expect(onDescription).toHaveBeenLastCalledWith("desc!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("disables Save while busy", () => {
    form(true);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("SettingsForm", () => {
  it("requires the name (64) and edits the description as markdown", async () => {
    const onSubmit = submitted();
    const onDescription = vi.fn();
    mount(
      <SettingsForm
        name="studio"
        description="**games**"
        onName={vi.fn()}
        onDescription={onDescription}
        onSubmit={onSubmit}
        busy={false}
      />,
    );
    const name = input("Name");
    expect(name.required).toBe(true);
    expect(name.maxLength).toBe(64);
    const body = screen.getByLabelText<HTMLTextAreaElement>("Description");
    expect(body.tagName).toBe("TEXTAREA");
    expect(body).toHaveValue("**games**");
    expect(
      screen.getByText("(Markdown; no HTML, no images)"),
    ).toBeInTheDocument();
    await userEvent.type(body, "!");
    expect(onDescription).toHaveBeenLastCalledWith("**games**!");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("disables Save while busy", () => {
    mount(
      <SettingsForm
        name="studio"
        description=""
        onName={vi.fn()}
        onDescription={vi.fn()}
        onSubmit={submitted()}
        busy
      />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});

describe("DraftForm", () => {
  const form = (
    draft: { title: string; bodyMd: string },
    busy = false,
    extra?: React.ReactNode,
  ) => {
    const onSubmit = submitted();
    const onChange = vi.fn();
    const onCancel = vi.fn();
    mount(
      <DraftForm
        draft={draft}
        onChange={onChange}
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitLabel="Open issue"
        bodyLabel="Description"
        busy={busy}
        extra={extra}
      />,
    );
    return { onSubmit, onChange, onCancel };
  };

  it("requires a title of at most 200 and labels the body as asked", () => {
    form({ title: "", bodyMd: "" });
    const title = input("Title");
    expect(title.required).toBe(true);
    expect(title.maxLength).toBe(200);
    expect(screen.getByLabelText("Description").tagName).toBe("TEXTAREA");
    expect(screen.getByRole("button", { name: "Open issue" })).toBeDisabled();
  });

  it("stays disabled for a blank title and while busy", () => {
    form({ title: "   ", bodyMd: "x" });
    expect(screen.getByRole("button", { name: "Open issue" })).toBeDisabled();
    cleanup();
    form({ title: "Crash", bodyMd: "" }, true);
    expect(screen.getByRole("button", { name: "Open issue" })).toBeDisabled();
  });

  it("reports whole drafts, submits and cancels", async () => {
    const { onSubmit, onChange, onCancel } = form({
      title: "Crash",
      bodyMd: "b",
    });
    await userEvent.type(input("Title"), "!");
    expect(onChange).toHaveBeenLastCalledWith({ title: "Crash!", bodyMd: "b" });
    await userEvent.type(screen.getByLabelText("Description"), "!");
    expect(onChange).toHaveBeenLastCalledWith({ title: "Crash", bodyMd: "b!" });
    await userEvent.click(screen.getByRole("button", { name: "Open issue" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("places extra between the title and the body", () => {
    form({ title: "t", bodyMd: "" }, false, <div data-testid="extra">v</div>);
    const order = [
      input("Title"),
      screen.getByTestId("extra"),
      screen.getByLabelText("Description"),
    ];
    expect(
      order[0]!.compareDocumentPosition(order[1]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      order[1]!.compareDocumentPosition(order[2]!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("FormActions", () => {
  it("shows Cancel only when the form can be dismissed", async () => {
    const onCancel = vi.fn();
    const r = mount(<FormActions submitLabel="Comment" disabled />);
    const submit = screen.getByRole("button", { name: "Comment" });
    expect(submit).toHaveAttribute("type", "submit");
    expect(submit).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    r.unmount();
    mount(<FormActions submitLabel="Save" onCancel={onCancel} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("DangerCard", () => {
  it("explains, arms and confirms with Delete", async () => {
    const onConfirm = vi.fn();
    mount(
      <DangerCard label="Delete team" onConfirm={onConfirm}>
        Deleting a team is refused while it still has projects.
      </DangerCard>,
    );
    expect(
      screen.getByText(
        "Deleting a team is refused while it still has projects.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete team" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("is inert while disabled", () => {
    mount(
      <DangerCard label="Delete project" onConfirm={vi.fn()} disabled>
        x
      </DangerCard>,
    );
    expect(
      screen.getByRole("button", { name: "Delete project" }),
    ).toBeDisabled();
  });
});

describe("LinkCell", () => {
  it("renders an in-app link inside a table cell", () => {
    mount(
      <Table>
        <Table.Tbody>
          <Table.Tr>
            <LinkCell to="/assets/ab_1">dungeon-maps</LinkCell>
          </Table.Tr>
        </Table.Tbody>
      </Table>,
    );
    const link = screen.getByRole("link", { name: "dungeon-maps" });
    expect(link).toHaveAttribute("href", "/assets/ab_1");
    expect(link.closest("td")).not.toBeNull();
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
