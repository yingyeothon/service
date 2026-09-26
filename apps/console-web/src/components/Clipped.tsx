import { Code, Collapse, Group, Tooltip, UnstyledButton } from "@mantine/core";
import { useId, useState, type ReactNode } from "react";

/**
 * One line, ellipsed at a fixed width (`max-width` on a `td` of an
 * auto-layout table does not hold, `rules/ui.md`). The full text is a
 * tooltip for the pointer and, for a tap or a keyboard, a fold inside the
 * cell where it is selectable (a kv owner id is 32 hex and always clipped;
 * it is what a member types into the filter or `--owner`). `prefix` sits on
 * the same line before the clipped text, the fold below both.
 */
export function Clipped({
  text,
  width,
  what,
  prefix,
}: {
  text: string;
  width: number;
  /** The fold's accessible name: "Full key". */
  what: string;
  prefix?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const foldId = useId();
  const clipped = (
    <Tooltip
      label={text}
      multiline
      w={Math.max(width, 320)}
      position="top-start"
      events={{ hover: !open, focus: !open, touch: false }}
      opened={open || armed ? false : undefined}
    >
      <UnstyledButton
        onClick={() => {
          setOpen((o) => !o);
          setArmed(true);
        }}
        onMouseLeave={() => setArmed(false)}
        onBlur={() => setArmed(false)}
        aria-expanded={open}
        aria-controls={foldId}
        style={{ display: "block", width, cursor: "pointer" }}
      >
        <Code
          style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {text}
        </Code>
      </UnstyledButton>
    </Tooltip>
  );
  return (
    <>
      {prefix ? (
        <Group gap={4} wrap="nowrap">
          {prefix}
          {clipped}
        </Group>
      ) : (
        clipped
      )}
      <Collapse in={open}>
        <Code
          block
          id={foldId}
          role="group"
          aria-label={what}
          mt={4}
          style={{
            maxWidth: Math.max(width, 320),
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            userSelect: "all",
          }}
        >
          {text}
        </Code>
      </Collapse>
    </>
  );
}
