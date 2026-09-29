import { Button } from "@mantine/core";
import { Component, type ReactNode } from "react";
import { Notice } from "./ui";

/**
 * The recovery path for a lazy chunk that fails to load (`todo/51`): a
 * dynamic `import()` that rejects (network drop, a CDN 5xx, a hashed file
 * pruned under an open tab) throws out of `Suspense`, and without a boundary
 * React unmounts the whole tree — a white console that only a hard reload
 * fixes. `fallback` degrades in place (`Markdown` shows the raw text);
 * without one, the boundary offers the reload itself.
 */
export class ChunkBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    console.error("chunk failed to load", error);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <Notice kind="error">
        Part of the console failed to load.{" "}
        <Button
          size="compact-sm"
          variant="default"
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      </Notice>
    );
  }
}
