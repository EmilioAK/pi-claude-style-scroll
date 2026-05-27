export interface StickyMouseScrollConfig {
  mouseScroll: boolean;
  alternateScroll: boolean;
}

export type StickyInputCommandAction =
  | { type: "toggle" }
  | { type: "setMouseScroll"; enabled: boolean }
  | { type: "status" }
  | { type: "help" }
  | { type: "error"; message: string };

const ENABLE_TOKENS = new Set(["on", "enable", "enabled", "mouse", "scroll"]);
const DISABLE_TOKENS = new Set(["off", "disable", "disabled", "native", "select", "selection", "links"]);
const STATUS_TOKENS = new Set(["status", "state"]);
const HELP_TOKENS = new Set(["help", "--help", "-h"]);

function tokenizeArgs(args: string): string[] {
  return args
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

export function parseStickyInputCommandArgs(args: string): StickyInputCommandAction {
  const tokens = tokenizeArgs(args);

  if (tokens.length === 0 || (tokens.length === 1 && (tokens[0] === "mouse" || tokens[0] === "toggle"))) {
    return { type: "toggle" };
  }

  const normalizedTokens = tokens[0] === "mouse" ? tokens.slice(1) : tokens;
  if (normalizedTokens.length !== 1) {
    return {
      type: "error",
      message: "Usage: /sticky-input [on|off|toggle|status] or /sticky-input mouse [on|off|status].",
    };
  }

  const [token] = normalizedTokens;
  if (token === "toggle") {
    return { type: "toggle" };
  }

  if (HELP_TOKENS.has(token)) {
    return { type: "help" };
  }

  if (STATUS_TOKENS.has(token)) {
    return { type: "status" };
  }

  if (ENABLE_TOKENS.has(token)) {
    return { type: "setMouseScroll", enabled: true };
  }

  if (DISABLE_TOKENS.has(token)) {
    return { type: "setMouseScroll", enabled: false };
  }

  return {
    type: "error",
    message: `Unknown pi-sticky-input command argument '${token}'. Use /sticky-input help.`,
  };
}

export function applyStickyMouseScrollMode(config: StickyMouseScrollConfig, enabled: boolean): void {
  config.mouseScroll = enabled;
  config.alternateScroll = false;
}

export function getStickyMouseScrollStatusMessage(enabled: boolean): string {
  return enabled
    ? "pi-sticky-input mouse-wheel chat scrolling is ON. Native terminal selection/link clicks are captured while this is on. Run /sticky-input off to restore native terminal mouse behavior."
    : "pi-sticky-input mouse-wheel chat scrolling is OFF. Native terminal selection/link clicks are preserved. Run /sticky-input on to enable mouse-wheel chat scrolling.";
}

export function getStickyInputCommandHelp(): string {
  return [
    "pi-sticky-input mouse mode command:",
    "  /sticky-input          Toggle mouse-wheel chat scrolling",
    "  /sticky-input on       Enable mouse-wheel chat scrolling",
    "  /sticky-input off      Restore native terminal selection/link clicks",
    "  /sticky-input status   Show current mode",
  ].join("\n");
}
