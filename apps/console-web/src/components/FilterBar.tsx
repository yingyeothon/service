import {
  CloseButton,
  Group,
  NativeSelect,
  SegmentedControl,
  Text,
  TextInput,
} from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useId, type ReactNode } from "react";

/**
 * The row of filters under a list header. Filters apply as they change —
 * `EnumFilter` and the free-text `TextFilter` alike (the latter debounced by
 * `useListQuery`, since each change is a request); the only `Apply` button
 * in the console is the audit log's free-text pair, which a page adds as its
 * own `<form>` child here.
 */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <Group gap="md" mb="md" align="flex-end" wrap="wrap" aria-label="Filters">
      {children}
    </Group>
  );
}

export interface FilterOption {
  value: string;
  label: string;
}

/**
 * One enum filter: up to four values are a segmented control (every choice
 * visible), more become a native select.
 */
export function EnumFilter({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  if (options.length <= 4)
    return (
      <div>
        <Text size="sm" fw={500} mb={4} id={id}>
          {label}
        </Text>
        <SegmentedControl
          aria-labelledby={id}
          value={value}
          data={options}
          onChange={onChange}
        />
      </div>
    );
  return (
    <NativeSelect
      label={label}
      value={value}
      data={options}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  );
}

/**
 * The server-side search of a list (`?q=`): a search box whose value the page
 * hands to `useListQuery`. Clearing it is one button.
 */
export function TextFilter({
  label = "Search",
  value,
  onChange,
  placeholder,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <TextInput
      type="search"
      label={label}
      value={value}
      placeholder={placeholder}
      w={260}
      leftSection={<IconSearch size={16} aria-hidden="true" />}
      rightSection={
        value ? (
          <CloseButton
            size="sm"
            aria-label="Clear search"
            onClick={() => onChange("")}
          />
        ) : null
      }
      onChange={(e) => onChange(e.currentTarget.value)}
      autoComplete="off"
      spellCheck={false}
    />
  );
}
