import { createTheme, type MantineColorsTuple } from "@mantine/core";

/** yyt accent (#2f5bea) as a Mantine 10-shade palette; index 6 is primary. */
const brand: MantineColorsTuple = [
  "#eaeffe",
  "#d3ddfb",
  "#a5b9f6",
  "#7392f2",
  "#4a71ee",
  "#345dec",
  "#2f5bea",
  "#204ad0",
  "#1941bb",
  "#0637a5",
];

/** Compact, light-only theme (small type scale, `size: sm` form defaults). */
export const theme = createTheme({
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  fontSizes: { xs: "11px", sm: "13px", md: "14px", lg: "16px", xl: "18px" },
  colors: { brand },
  primaryColor: "brand",
  primaryShade: 6,
  defaultRadius: "sm",
  components: {
    Button: { defaultProps: { size: "sm" } },
    TextInput: { defaultProps: { size: "sm" } },
    NumberInput: { defaultProps: { size: "sm" } },
    Select: { defaultProps: { size: "sm" } },
    NativeSelect: { defaultProps: { size: "sm" } },
    Textarea: { defaultProps: { size: "sm" } },
    PasswordInput: { defaultProps: { size: "sm" } },
    Table: { defaultProps: { verticalSpacing: 6, horizontalSpacing: "sm" } },
  },
});
