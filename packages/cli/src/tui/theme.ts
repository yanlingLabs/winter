// Semantic color theme for the TUI (Claude-Code-shaped keys, Norma's own accent).
// Values are hex strings suitable for Ink `color`/`backgroundColor` props and
// for building `chalk.hex(...)` instances in the markdown/highlight pipeline.
export const theme = {
  accent: "#73BFFF", // Norma blue — replaces CC's brand key everywhere it appears
  text: "#FFFFFF",
  subtle: "#505050",
  inactive: "#999999",
  success: "#4EBA65",
  error: "#FF6B80",
  warning: "#FFC107",
  permission: "#B1B9F9", // inline-code color
  promptBorder: "#888888",
  userMessageBackground: "#373737",
  planMode: "#48968C",
  autoAccept: "#AF87FF",
  dangerMode: "#FF5F5F", // SP-policies Task 13 — bypass mode's footer color (all actions auto-approved)
  diffAdded: "#225C2B",
  diffRemoved: "#7A2936",
} as const;

export type ThemeKey = keyof typeof theme;
