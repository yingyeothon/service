import { MantineProvider, mergeThemeOverrides } from "@mantine/core";
import { ModalsProvider } from "@mantine/modals";
import { Notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import type { ApiClient } from "../src/api";
import { AuthProvider } from "../src/auth";
import { theme } from "../src/theme";

/*
 * The provider stack of `main.tsx`, for tests. Drawer and modal transitions
 * are zeroed so `findByRole("dialog")` resolves without waiting them out.
 * `client` is the test's mocked api; import this module only after
 * `vi.mock("../src/api", …)` has been declared (it is hoisted, so a static
 * import at the top of the test file is fine).
 */

const testTheme = mergeThemeOverrides(theme, {
  components: {
    Drawer: { defaultProps: { transitionProps: { duration: 0 } } },
    Modal: { defaultProps: { transitionProps: { duration: 0 } } },
    Menu: { defaultProps: { transitionProps: { duration: 0 } } },
  },
});

export function Providers({
  children,
  path = "/",
  client,
  auth = true,
}: {
  children: ReactNode;
  path?: string;
  client?: ApiClient;
  /** Skip `AuthProvider` for components that never read the session. */
  auth?: boolean;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const inner = <ModalsProvider>{children}</ModalsProvider>;
  return (
    <MantineProvider theme={testTheme} forceColorScheme="light" env="test">
      <Notifications />
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          {auth ? <AuthProvider client={client}>{inner}</AuthProvider> : inner}
        </MemoryRouter>
      </QueryClientProvider>
    </MantineProvider>
  );
}

export function mount(
  ui: ReactNode,
  opts: { path?: string; client?: ApiClient; auth?: boolean } = {},
) {
  return render(<Providers {...opts}>{ui}</Providers>);
}
