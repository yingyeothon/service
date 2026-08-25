import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

// Mantine components touch browser APIs jsdom does not implement.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
if (!("ResizeObserver" in window)) {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (window as unknown as { ResizeObserver: unknown }).ResizeObserver =
    ResizeObserverMock;
}
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

/**
 * Mantine's `AppShell` schedules a `transitionDuration` timeout in an effect it
 * never clears on unmount (`@mantine/core` `use-resizing`). A file that finishes
 * before that timer fires leaves it to land after jsdom is torn down, where
 * React's `shouldAttemptEagerTransition` reads `window` and throws — vitest
 * reports it as an unhandled error and `pnpm test` fails, roughly one run in
 * six and only under parallel load. Tracking timers and clearing them after
 * each test removes the race without waiting the transition out.
 */
const pending = new Set<number>();
const realSetTimeout = window.setTimeout.bind(window);
const realClearTimeout = window.clearTimeout.bind(window);
window.setTimeout = ((
  handler: TimerHandler,
  timeout?: number,
  ...args: unknown[]
) => {
  const id = realSetTimeout(handler as never, timeout, ...args);
  pending.add(id);
  return id;
}) as typeof window.setTimeout;
window.clearTimeout = ((id?: number) => {
  if (id !== undefined) pending.delete(id);
  realClearTimeout(id);
}) as typeof window.clearTimeout;

afterEach(() => {
  // Unmount first: a component that clears its own timer on unmount should be
  // allowed to, so the sweep below only ever catches the ones that do not.
  cleanup();
  for (const id of pending) realClearTimeout(id);
  pending.clear();
});
