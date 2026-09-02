import { Table } from "@mantine/core";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DataTable, NameCell } from "../src/components/DataTable";
import { EnumFilter, FilterBar, TextFilter } from "../src/components/FilterBar";
import { PageHeader } from "../src/components/PageHeader";
import { ReadOnlyBanner } from "../src/components/ReadOnlyBanner";
import {
  ResourceDrawer,
  useDrawerForm,
} from "../src/components/ResourceDrawer";
import { RowMenu } from "../src/components/RowMenu";
import { Section } from "../src/components/Section";
import { mount, Providers } from "./wrap";

/*
 * The page grammar kit: what every list and detail page is built from. These
 * pin the positions and the vocabulary — one filled button, the overflow
 * menu, the drawer's footer and danger zone, a table's three non-data states
 * — so a page cannot drift back to its own arrangement.
 */

describe("PageHeader", () => {
  it("renders the page's h1, one filled button and the overflow menu", async () => {
    const edit = vi.fn();
    const del = vi.fn();
    mount(
      <PageHeader
        title="dungeon"
        actions={[
          { label: "New channel", primary: true, to: "/x" },
          { label: "Edit", onClick: edit },
          { label: "Delete project", danger: true, onClick: del },
        ]}
      />,
      { auth: false },
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "dungeon" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New channel" })).toHaveAttribute(
      "href",
      "/x",
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(edit).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Delete project" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete project" }),
    );
    expect(del).toHaveBeenCalled();
  });
  it("paints a skeleton while the title is unknown", () => {
    mount(<PageHeader />, { auth: false });
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
    expect(screen.getByLabelText("Loading…")).toBeInTheDocument();
  });
});

describe("Section", () => {
  it("is a section with an h2", () => {
    mount(
      <Section title="Deploys" description="One per zip.">
        <p>body</p>
      </Section>,
      { auth: false },
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "Deploys" }),
    ).toBeInTheDocument();
    expect(screen.getByText("One per zip.")).toBeInTheDocument();
  });
});

describe("ReadOnlyBanner", () => {
  it("says the one sentence", () => {
    mount(<ReadOnlyBanner detail="Admins may delete it." />, { auth: false });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Read-only: you are not seated in this team, so you can look but not change anything. Admins may delete it.",
    );
  });
});

describe("DataTable", () => {
  const columns = [
    { key: "name", label: "Name" },
    { key: "n", label: "Count", align: "right" as const },
  ];
  const row = (r: { id: string; n: number }) => (
    <>
      <NameCell to={`/things/${r.id}`}>{r.id}</NameCell>
      <Table.Td>{r.n}</Table.Td>
    </>
  );
  it("shows skeleton rows while loading", () => {
    mount(
      <DataTable
        columns={columns}
        rows={undefined}
        loading
        rowKey={(r) => r.id}
        render={row}
        empty={{ title: "No things yet." }}
      />,
      { auth: false },
    );
    expect(screen.getByRole("table", { name: "Loading…" })).toBeInTheDocument();
  });
  it("renders the error instead of rows", () => {
    mount(
      <DataTable
        columns={columns}
        rows={undefined}
        error="boom"
        rowKey={(r) => r.id}
        render={row}
        empty={{ title: "No things yet." }}
      />,
      { auth: false },
    );
    expect(screen.getByRole("alert")).toHaveTextContent("boom");
  });
  it("renders the empty state", () => {
    mount(
      <DataTable
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        render={row}
        empty={{ title: "No things yet.", hint: "Create one above." }}
      />,
      { auth: false },
    );
    expect(screen.getByText("No things yet.")).toBeInTheDocument();
    expect(screen.getByText("Create one above.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
  it("renders rows with the name link and the actions column", async () => {
    const kick = vi.fn();
    mount(
      <DataTable
        columns={columns}
        rows={[
          { id: "a", n: 1 },
          { id: "b", n: 2 },
        ]}
        rowKey={(r) => r.id}
        render={row}
        empty={{ title: "No things yet." }}
        actions={(r) => (
          <RowMenu
            name={r.id}
            items={[
              {
                label: "Kick",
                danger: true,
                onClick: kick,
                confirm: {
                  title: "Kick a?",
                  confirmLabel: "Kick",
                  danger: true,
                },
              },
            ]}
          />
        )}
      />,
      { auth: false },
    );
    expect(screen.getByRole("link", { name: "a" })).toHaveAttribute(
      "href",
      "/things/a",
    );
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveStyle({
      textAlign: "right",
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for a" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Kick" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Kick a?")).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    expect(kick).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Actions for a" }),
    );
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Kick" }),
    );
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Kick",
      }),
    );
    await waitFor(() => expect(kick).toHaveBeenCalledWith(undefined));
  });
});

describe("DataTable sorting", () => {
  const columns = [
    { key: "name", label: "Name", sortKey: "name" },
    {
      key: "n",
      label: "Count",
      sortKey: "count",
      defaultOrder: "desc" as const,
    },
    { key: "plain", label: "Plain" },
  ];
  const row = (r: { id: string }) => (
    <>
      <NameCell to={`/things/${r.id}`}>{r.id}</NameCell>
      <Table.Td>1</Table.Td>
      <Table.Td>x</Table.Td>
    </>
  );
  it("cycles a header through its default order, the other, and none; marks the th", async () => {
    const onSort = vi.fn();
    const { rerender } = mount(
      <DataTable
        columns={columns}
        rows={[{ id: "a" }]}
        rowKey={(r) => r.id}
        render={row}
        empty={{ title: "None." }}
        sort={null}
        onSort={onSort}
      />,
      { auth: false },
    );
    // A column without `sortKey` is plain text.
    expect(screen.queryByRole("button", { name: "Plain" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Name" }));
    expect(onSort).toHaveBeenLastCalledWith({ key: "name", order: "asc" });
    // Times and counts start descending.
    await userEvent.click(screen.getByRole("button", { name: "Count" }));
    expect(onSort).toHaveBeenLastCalledWith({ key: "count", order: "desc" });
    const table = (sort: { key: string; order: "asc" | "desc" } | null) => (
      <Providers auth={false}>
        <DataTable
          columns={columns}
          rows={[{ id: "a" }]}
          rowKey={(r) => r.id}
          render={row}
          empty={{ title: "None." }}
          sort={sort}
          onSort={onSort}
        />
      </Providers>
    );
    rerender(table({ key: "count", order: "desc" }));
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(
      screen.getByRole("columnheader", { name: "Name" }),
    ).not.toHaveAttribute("aria-sort");
    await userEvent.click(screen.getByRole("button", { name: "Count" }));
    expect(onSort).toHaveBeenLastCalledWith({ key: "count", order: "asc" });
    rerender(table({ key: "count", order: "asc" }));
    expect(screen.getByRole("columnheader", { name: "Count" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await userEvent.click(screen.getByRole("button", { name: "Count" }));
    expect(onSort).toHaveBeenLastCalledWith(null);
  });
});

describe("FilterBar", () => {
  it("renders the search box with a clear button that empties it", async () => {
    const onChange = vi.fn();
    mount(
      <FilterBar>
        <TextFilter value="dun" onChange={onChange} placeholder="Name" />
      </FilterBar>,
      { auth: false },
    );
    const box = screen.getByRole("searchbox", { name: "Search" });
    expect(box).toHaveValue("dun");
    await userEvent.type(box, "g");
    expect(onChange).toHaveBeenLastCalledWith("dung");
    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onChange).toHaveBeenLastCalledWith("");
  });
  it("uses a segmented control up to four values and a select beyond", () => {
    mount(
      <FilterBar>
        <EnumFilter
          label="Status"
          value="open"
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ]}
          onChange={() => {}}
        />
        <EnumFilter
          label="Kind"
          value="a"
          options={["a", "b", "c", "d", "e"].map((v) => ({
            value: v,
            label: v,
          }))}
          onChange={() => {}}
        />
      </FilterBar>,
      { auth: false },
    );
    expect(
      screen.getByRole("radiogroup", { name: "Status" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Kind" })).toBeInTheDocument();
  });
});

function DrawerHarness({
  onSubmit,
  onDelete,
}: {
  onSubmit: (name: string) => Promise<unknown>;
  onDelete: () => void;
}) {
  const d = useDrawerForm(() => ({ name: "old" }));
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button onClick={d.open}>Edit</button>
      <ResourceDrawer
        opened={d.opened}
        onClose={d.close}
        title="Edit thing"
        submitLabel="Save"
        error={error}
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await onSubmit(d.form.name);
          if (r) d.close();
          else setError("nope");
        }}
        danger={{
          label: "Delete thing",
          description: "Gone for good.",
          onConfirm: onDelete,
        }}
      >
        <label>
          Name
          <input
            value={d.form.name}
            onChange={(e) => d.patch({ name: e.target.value })}
          />
        </label>
      </ResourceDrawer>
    </>
  );
}

describe("ResourceDrawer", () => {
  it("opens with the initial values, cancels without submitting, submits and closes", async () => {
    const onSubmit = vi.fn(async () => ({ ok: true }));
    mount(<DrawerHarness onSubmit={onSubmit} onDelete={() => {}} />, {
      auth: false,
    });
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Edit thing")).toBeInTheDocument();
    const input = within(dialog).getByLabelText("Name");
    expect(input).toHaveValue("old");
    await userEvent.clear(input);
    await userEvent.type(input, "draft");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Reopened: the draft is gone, the initial value is back.
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const again = await screen.findByRole("dialog");
    expect(within(again).getByLabelText("Name")).toHaveValue("old");
    await userEvent.click(within(again).getByRole("button", { name: "Save" }));
    expect(onSubmit).toHaveBeenCalledWith("old");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("keeps the drawer open with the inline error when the request fails", async () => {
    mount(
      <DrawerHarness onSubmit={async () => undefined} onDelete={() => {}} />,
      { auth: false },
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("nope");
  });
  it("confirms the danger zone with the same verb", async () => {
    const onDelete = vi.fn();
    mount(<DrawerHarness onSubmit={async () => ({})} onDelete={onDelete} />, {
      auth: false,
    });
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    const drawer = await screen.findByRole("dialog");
    await userEvent.click(
      within(drawer).getByRole("button", { name: "Delete thing" }),
    );
    const title = await screen.findByText("Delete thing?");
    const modal = title.closest('[role="dialog"]') as HTMLElement;
    await userEvent.click(
      within(modal).getByRole("button", { name: "Delete thing" }),
    );
    await waitFor(() => expect(onDelete).toHaveBeenCalled());
  });
});
