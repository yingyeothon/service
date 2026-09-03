import {
  ActionIcon,
  Alert,
  Anchor,
  AppShell,
  Badge,
  Button,
  Card,
  Drawer,
  Input,
  Modal,
  Notification,
  Paper,
  SegmentedControl,
  Skeleton,
  Table,
  Tabs,
  Tooltip,
  createTheme,
  rem,
  type CSSVariablesResolver,
  type MantineColorsTuple,
} from "@mantine/core";

/*
 * The design system lives in `DESIGN.md` (this directory); this file maps its
 * tokens onto Mantine. Two palettes carry the whole console: `ink` is the
 * near-black primary (buttons, active tabs, headings), `link` is the blue of
 * inline links and the focus ring — never a button colour.
 */

/** DESIGN.md `primary` #181d26 at index 6, `primary-active` #0d1218 at 7. */
const ink: MantineColorsTuple = [
  "#f8fafc",
  "#e0e2e6",
  "#c5c9cf",
  "#9297a0",
  "#6b7079",
  "#41454d",
  "#181d26",
  "#0d1218",
  "#0a0e14",
  "#05080c",
];

/** DESIGN.md `link` #1b61c9 at index 6, `info-border` #458fff at 4. */
const link: MantineColorsTuple = [
  "#e8f0fc",
  "#c9dbf7",
  "#9bbdf0",
  "#6c9ee8",
  "#458fff",
  "#254fad",
  "#1b61c9",
  "#1a3866",
  "#142a4d",
  "#0d1b33",
];

export const HAIRLINE = "#dddddd";
export const SURFACE_SOFT = "#f8fafc";
export const INFO_BORDER = "#458fff";

export const theme = createTheme({
  primaryColor: "ink",
  primaryShade: 6,
  colors: { ink, link },
  // Inter stands in for Haas Grotesk (DESIGN.md, font substitutes); it has no
  // Hangul, so user text in Korean falls through to the system faces.
  fontFamily:
    '"Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif',
  fontSizes: { xs: "12px", sm: "14px", md: "14px", lg: "16px", xl: "18px" },
  lineHeights: { xs: "1.25", sm: "1.25", md: "1.4", lg: "1.5", xl: "1.5" },
  headings: {
    fontWeight: "400",
    sizes: {
      h1: { fontSize: "24px", lineHeight: "1.35", fontWeight: "400" },
      h2: { fontSize: "18px", lineHeight: "1.4", fontWeight: "500" },
      h3: { fontSize: "16px", lineHeight: "1.4", fontWeight: "500" },
      h4: { fontSize: "14px", lineHeight: "1.4", fontWeight: "500" },
      h5: { fontSize: "14px", lineHeight: "1.4", fontWeight: "500" },
      h6: { fontSize: "14px", lineHeight: "1.4", fontWeight: "500" },
    },
  },
  radius: { xs: "2px", sm: "6px", md: "10px", lg: "12px", xl: "12px" },
  defaultRadius: "sm",
  spacing: { xs: "8px", sm: "12px", md: "16px", lg: "24px", xl: "32px" },
  // Colour-block first, shadow second: depth comes from hairlines and surfaces.
  shadows: { xs: "none", sm: "none", md: "none", lg: "none", xl: "none" },
  components: {
    Button: Button.extend({
      defaultProps: { radius: "lg", size: "md" },
      styles: { root: { fontWeight: 500 } },
    }),
    ActionIcon: ActionIcon.extend({
      defaultProps: { radius: "xl", variant: "default", size: "lg" },
    }),
    Input: Input.extend({
      defaultProps: { size: "md" },
      vars: (_theme, props) => ({
        wrapper: {
          "--input-height": props.multiline ? undefined : rem(44),
          "--input-radius": rem(6),
          "--input-bd": HAIRLINE,
          "--input-bd-focus": INFO_BORDER,
        },
      }),
    }),
    InputWrapper: {
      defaultProps: { size: "md" },
      styles: {
        label: { fontWeight: 500, fontSize: rem(14), marginBottom: rem(4) },
        description: { fontSize: rem(14) },
      },
    },
    Card: Card.extend({
      defaultProps: { withBorder: true, radius: "md", padding: "lg" },
      styles: { root: { borderColor: HAIRLINE } },
    }),
    Paper: Paper.extend({
      defaultProps: { radius: "md" },
      styles: { root: { borderColor: HAIRLINE } },
    }),
    Table: Table.extend({
      defaultProps: {
        verticalSpacing: "sm",
        horizontalSpacing: "md",
        withRowBorders: true,
        borderColor: HAIRLINE,
      },
      styles: {
        table: { fontVariantNumeric: "tabular-nums" },
        th: { fontWeight: 500, color: "#41454d" },
      },
    }),
    Tabs: Tabs.extend({
      defaultProps: { variant: "default" },
      styles: { tab: { fontWeight: 500, paddingBlock: rem(12) } },
    }),
    Drawer: Drawer.extend({
      defaultProps: {
        position: "right",
        size: "md",
        padding: "lg",
        overlayProps: { backgroundOpacity: 0.35 },
      },
      styles: { title: { fontSize: rem(20), fontWeight: 400 } },
    }),
    Modal: Modal.extend({
      // Above the drawer (200): a danger-zone confirm opens over its drawer.
      defaultProps: {
        radius: "md",
        zIndex: 300,
        overlayProps: { backgroundOpacity: 0.35 },
      },
      styles: { title: { fontSize: rem(18), fontWeight: 500 } },
    }),
    Badge: Badge.extend({
      defaultProps: { variant: "light", radius: "sm" },
      styles: {
        root: { textTransform: "none", fontWeight: 500, letterSpacing: 0 },
      },
    }),
    Notification: Notification.extend({
      defaultProps: { radius: "md", withBorder: true },
    }),
    Alert: Alert.extend({ defaultProps: { radius: "md", variant: "light" } }),
    Anchor: Anchor.extend({ defaultProps: { underline: "hover" } }),
    SegmentedControl: SegmentedControl.extend({
      defaultProps: { radius: "sm", size: "sm" },
      styles: { root: { backgroundColor: SURFACE_SOFT } },
    }),
    // Hover detail in a table (the catalog artifact's metadata) — Mantine's
    // default gray is not a token, so it takes DESIGN.md's `surface-dark`.
    Tooltip: Tooltip.extend({
      defaultProps: { radius: "sm", withArrow: true },
      styles: { tooltip: { backgroundColor: "#181d26" } },
    }),
    Skeleton: Skeleton.extend({ defaultProps: { radius: "sm" } }),
    AppShell: AppShell.extend({
      styles: {
        header: { borderColor: HAIRLINE },
        navbar: { borderColor: HAIRLINE },
      },
    }),
  },
});

/** Body, dimmed and link colours from DESIGN.md; a soft hover on default buttons. */
export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    "--mantine-color-text": "#333840",
    "--mantine-color-dimmed": "#41454d",
    "--mantine-color-anchor": "#1b61c9",
    "--mantine-color-body": "#ffffff",
    "--mantine-color-default-border": HAIRLINE,
    "--mantine-color-default-hover": SURFACE_SOFT,
    // Light-variant badges and alerts: DESIGN.md `success` and a mustard
    // dark enough for AA on the tinted surface, instead of Mantine's shade 6.
    "--mantine-color-green-light-color": "#006400",
    "--mantine-color-yellow-light-color": "#7a5200",
    "--mantine-color-yellow-light": "rgba(244, 211, 94, 0.25)",
  },
  dark: {},
});
