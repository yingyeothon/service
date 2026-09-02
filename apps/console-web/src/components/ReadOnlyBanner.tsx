import type { ReactNode } from "react";
import { Notice } from "./ui";

/** The one sentence every page says when the caller has no seat in the team. */
export function ReadOnlyBanner({ detail }: { detail?: ReactNode }) {
  return (
    <Notice>
      Read-only: you are not seated in this team, so you can look but not change
      anything.
      {detail ? <> {detail}</> : null}
    </Notice>
  );
}
