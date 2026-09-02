import { ActionIcon, Menu } from "@mantine/core";
import { IconDots } from "@tabler/icons-react";
import { useConfirm, type ConfirmOptions } from "../lib/confirm";

/** One entry of a row's menu; a `confirm` runs first and hands its reason on. */
export interface RowMenuItem {
  label: string;
  onClick: (reason?: string) => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
  confirm?: ConfirmOptions;
}

/**
 * The last cell of a table row: a kebab that opens the row's verbs. A
 * destructive verb confirms in a modal, so the row itself never reflows.
 */
export function RowMenu({
  name,
  items,
}: {
  /** Names the row for assistive tech: "Actions for alice". */
  name: string;
  items: RowMenuItem[];
}) {
  const confirm = useConfirm();
  if (items.length === 0) return null;
  const run = async (item: RowMenuItem) => {
    if (item.confirm) {
      const r = await confirm(item.confirm);
      if (!r.ok) return;
      await item.onClick(r.reason);
      return;
    }
    await item.onClick();
  };
  return (
    <Menu position="bottom-end" withinPortal>
      <Menu.Target>
        <ActionIcon variant="subtle" aria-label={`Actions for ${name}`}>
          <IconDots size={16} aria-hidden="true" />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {items.map((item) => (
          <Menu.Item
            key={item.label}
            color={item.danger ? "red" : undefined}
            disabled={item.disabled}
            onClick={() => void run(item)}
          >
            {item.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
