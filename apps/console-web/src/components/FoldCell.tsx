import { Collapse, Stack, Tooltip, UnstyledButton } from "@mantine/core";
import { useId, useState, type ReactNode } from "react";

/**
 * A table cell whose one visible line is a disclosure: the rest of what the
 * row has to say (a summary, the other download links) is a tooltip for the
 * pointer and a fold inside the same cell for a tap or a keyboard
 * (`rules/ui.md` #2–#4: one line tall, no hover-only affordance, a real
 * button). `label` is the line and the control's accessible name; `detail`
 * is what folds out, under `what` for assistive tech.
 */
export function FoldCell({
  label,
  detail,
  tooltip,
  what,
  width,
  dimmed,
  before,
  ariaLabel,
}: {
  label: string;
  detail: ReactNode;
  /** What the pointer's tooltip shows when it must differ from `detail` (a tooltip cannot be clicked, so no links). */
  tooltip?: ReactNode;
  what: string;
  width: number;
  dimmed?: boolean;
  /** Inline content before the button on the same line (a first link). */
  before?: ReactNode;
  /** The control's name when the label alone does not say what it opens; the visible label leads it. */
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [armed, setArmed] = useState(false);
  const foldId = useId();
  return (
    <>
      {before}
      <Tooltip
        label={tooltip ?? detail}
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
          aria-label={ariaLabel}
          c={dimmed ? "dimmed" : undefined}
          style={{
            display: before ? "inline-block" : "block",
            width,
            maxWidth: "100%",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            verticalAlign: "bottom",
            font: "inherit",
            fontWeight: 500,
            cursor: "pointer",
            // A one-line button is ~18 px on its own; the target is 24.
            paddingBlock: 3,
            textDecoration: "underline dotted",
            textUnderlineOffset: 3,
          }}
        >
          {label}
        </UnstyledButton>
      </Tooltip>
      <Collapse in={open}>
        <Stack
          gap={4}
          mt="xs"
          id={foldId}
          role="group"
          aria-label={what}
          style={{ maxWidth: Math.max(width, 320), whiteSpace: "normal" }}
        >
          {detail}
        </Stack>
      </Collapse>
    </>
  );
}
