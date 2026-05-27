import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

import {
  applyStickyMouseScrollMode,
  getStickyInputCommandHelp,
  getStickyMouseScrollStatusMessage,
  parseStickyInputCommandArgs,
} from "./commands/mouse-scroll-command.js";
import { loadStickyInputConfig, type StickyInputConfigLoadResult } from "./config/config.js";
import { DebugLogger } from "./logging/debug-logger.js";
import {
  applyStickySplitFooterRendererPatch,
  configureStickySplitFooterRenderer,
  getStickySplitFooterPatchStatus,
  resetStickySplitFooterViewport,
  scrollStickySplitFooterViewport,
  type StickySplitFooterPatchStatus,
} from "./tui/split-footer-renderer.js";
import {
  activateStickyTerminalSession,
  deactivateStickyTerminalSession,
  getActiveStickyTerminalTui,
  getKeyboardScrollRows as getTerminalKeyboardScrollRows,
  isMouseInput,
  shouldHandleStickyTerminalInput,
  parseAlternateScrollInput,
  parseMouseWheelInput,
} from "./tui/terminal-session.js";

const EXTENSION_ID = "pi-sticky-input";
const RUNTIME_PATCH_WIDGET_KEY = `${EXTENSION_ID}:runtime-renderer-hook`;

interface RuntimeState {
  configResult: StickyInputConfigLoadResult;
  logger: DebugLogger;
  patchStatus: StickySplitFooterPatchStatus;
}

class StickyRendererHookComponent implements Component {
  render(_width: number): string[] {
    return [];
  }

  invalidate(): void {
    // No cached state.
  }
}

function getRendererEnabled(configResult: StickyInputConfigLoadResult): boolean {
  const { config } = configResult;
  return config.enabled && config.splitFooterRenderer;
}

function createRendererOptions(configResult: StickyInputConfigLoadResult, logger: DebugLogger) {
  const { config } = configResult;
  return {
    enabled: getRendererEnabled(configResult),
    minimumHistoryRows: config.minimumHistoryRows,
    historyViewportLineLimit: config.historyViewportLineLimit,
    diagnostic: (event: string, fields: Record<string, unknown>) => {
      logger.log(event, fields);
    },
  };
}

function createRuntimeState(): RuntimeState {
  const configResult = loadStickyInputConfig();
  const logger = DebugLogger.create(configResult.config);
  configureStickySplitFooterRenderer(createRendererOptions(configResult, logger));
  const patchStatus = getStickySplitFooterPatchStatus();
  return {
    configResult,
    logger,
    patchStatus,
  };
}

function notifyWarnings(ctx: ExtensionContext, warnings: readonly string[]): void {
  if (!ctx.hasUI || warnings.length === 0) {
    return;
  }

  for (const warning of warnings) {
    ctx.ui.notify(`${EXTENSION_ID}: ${warning}`, "warning");
  }
}

function isEditorTextEmpty(getEditorText: (() => string) | undefined): boolean {
  if (!getEditorText) {
    return true;
  }

  try {
    return getEditorText().length === 0;
  } catch {
    return true;
  }
}

function handleStickyTerminalInput(
  runtime: RuntimeState,
  data: string,
  getEditorText?: () => string,
): { consume?: boolean; data?: string } | undefined {
  const { config } = runtime.configResult;
  const tui = getActiveStickyTerminalTui();

  if (!shouldHandleStickyTerminalInput(tui)) {
    return undefined;
  }

  const editorTextEmpty = isEditorTextEmpty(getEditorText);

  if (config.alternateScroll) {
    const direction = parseAlternateScrollInput(data, { allowCursorKeys: editorTextEmpty });
    if (direction) {
      const deltaRows = direction === "up" ? -config.mouseWheelScrollRows : config.mouseWheelScrollRows;
      const result = scrollStickySplitFooterViewport(tui, deltaRows);
      runtime.logger.log("terminal_alternate_scroll", {
        direction,
        deltaRows,
        handled: result.handled,
        changed: result.changed,
        viewportTop: result.viewportTop,
        followBottom: result.followBottom,
      });
      return { consume: true };
    }
  }

  if (config.mouseScroll && isMouseInput(data)) {
    const direction = parseMouseWheelInput(data);
    if (direction) {
      const deltaRows = direction === "up" ? -config.mouseWheelScrollRows : config.mouseWheelScrollRows;
      const result = scrollStickySplitFooterViewport(tui, deltaRows);
      runtime.logger.log("terminal_mouse_scroll", {
        direction,
        deltaRows,
        handled: result.handled,
        changed: result.changed,
        viewportTop: result.viewportTop,
        followBottom: result.followBottom,
      });
    }

    return { consume: true };
  }

  const keyboardScrollRows = config.keyboardScroll
    ? getTerminalKeyboardScrollRows(data, config.keyboardScrollRows, { allowPlainHomeEnd: editorTextEmpty })
    : undefined;
  if (keyboardScrollRows !== undefined) {
    const result = scrollStickySplitFooterViewport(tui, keyboardScrollRows);
    if (result.handled) {
      runtime.logger.log("terminal_keyboard_scroll", {
        deltaRows: keyboardScrollRows,
        changed: result.changed,
        viewportTop: result.viewportTop,
        followBottom: result.followBottom,
      });
      return { consume: true };
    }
  }

  return undefined;
}

function applyRuntimeMouseScrollMode(runtime: RuntimeState, enabled: boolean): void {
  const { config } = runtime.configResult;
  applyStickyMouseScrollMode(config, enabled);

  const tui = getActiveStickyTerminalTui();
  if (!tui || !getRendererEnabled(runtime.configResult)) {
    return;
  }

  activateStickyTerminalSession(tui, {
    alternateScreen: config.alternateScreen,
    alternateScroll: config.alternateScroll,
    mouseScroll: config.mouseScroll,
    diagnostic: (event, fields) => runtime.logger.log(event, fields),
  });
}

function installSplitFooterRendererHook(ctx: ExtensionContext, runtime: RuntimeState): void {
  if (!ctx.hasUI) {
    return;
  }

  if (!getRendererEnabled(runtime.configResult)) {
    resetStickySplitFooterViewport(getActiveStickyTerminalTui());
    deactivateStickyTerminalSession((event, fields) => runtime.logger.log(event, fields));
    ctx.ui.setWidget(RUNTIME_PATCH_WIDGET_KEY, undefined);
    return;
  }

  ctx.ui.setWidget(
    RUNTIME_PATCH_WIDGET_KEY,
    (tui: TUI) => {
      runtime.patchStatus = applyStickySplitFooterRendererPatch(
        createRendererOptions(runtime.configResult, runtime.logger),
        tui,
      );

      const { config } = runtime.configResult;
      if (runtime.patchStatus.installed && runtime.patchStatus.active) {
        activateStickyTerminalSession(tui, {
          alternateScreen: config.alternateScreen,
          alternateScroll: config.alternateScroll,
          mouseScroll: config.mouseScroll,
          diagnostic: (event, fields) => runtime.logger.log(event, fields),
        });
      }

      runtime.logger.log("split_footer_renderer_runtime_patch", {
        installed: runtime.patchStatus.installed,
        active: runtime.patchStatus.active,
        reason: runtime.patchStatus.reason,
        alternateScreen: config.alternateScreen,
        alternateScroll: config.alternateScroll,
        mouseScroll: config.mouseScroll,
        mouseWheelScrollRows: config.mouseWheelScrollRows,
        keyboardScroll: config.keyboardScroll,
        keyboardScrollRows: config.keyboardScrollRows,
        startupRedrawFixCompatibility: "terminal-write-wrapper-safe",
      });
      return new StickyRendererHookComponent();
    },
    { placement: "belowEditor" },
  );
}

export default function stickyInputExtension(pi: ExtensionAPI): void {
  let runtime = createRuntimeState();
  let unsubscribeTerminalInput: (() => void) | undefined;

  pi.registerCommand("sticky-input", {
    description: "Toggle pi-sticky-input mouse-wheel chat scrolling.",
    handler: async (args, ctx) => {
      const action = parseStickyInputCommandArgs(args);
      if (action.type === "error") {
        ctx.ui.notify(action.message, "warning");
        return;
      }

      if (action.type === "help") {
        ctx.ui.notify(getStickyInputCommandHelp(), "info");
        return;
      }

      if (action.type === "status") {
        ctx.ui.notify(getStickyMouseScrollStatusMessage(runtime.configResult.config.mouseScroll), "info");
        return;
      }

      const enabled = action.type === "toggle" ? !runtime.configResult.config.mouseScroll : action.enabled;
      applyRuntimeMouseScrollMode(runtime, enabled);
      runtime.logger.log("mouse_scroll_command", {
        enabled,
        alternateScroll: runtime.configResult.config.alternateScroll,
      });
      ctx.ui.notify(getStickyMouseScrollStatusMessage(enabled), "info");
    },
  });

  function clearTerminalInputListener(): void {
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
  }

  function installTerminalInputListener(ctx: ExtensionContext): void {
    clearTerminalInputListener();

    const { config } = runtime.configResult;
    if (
      !ctx.hasUI
      || !getRendererEnabled(runtime.configResult)
      || (!config.alternateScroll && !config.mouseScroll && !config.keyboardScroll)
    ) {
      return;
    }

    unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => handleStickyTerminalInput(
      runtime,
      data,
      () => ctx.ui.getEditorText(),
    ));
  }

  pi.on("resources_discover", (event, ctx) => {
    if (event.reason !== "reload") {
      return;
    }

    runtime = createRuntimeState();
    installSplitFooterRendererHook(ctx, runtime);
    installTerminalInputListener(ctx);
  });

  pi.on("session_start", (_event, ctx) => {
    runtime = createRuntimeState();
    const { config } = runtime.configResult;

    notifyWarnings(ctx, runtime.configResult.warnings);
    installSplitFooterRendererHook(ctx, runtime);
    installTerminalInputListener(ctx);
    runtime.logger.log("session_start", {
      enabled: config.enabled,
      hasUI: ctx.hasUI,
      splitFooterRenderer: config.splitFooterRenderer,
      splitFooterRendererActive: runtime.patchStatus.active,
      splitFooterRendererPatchInstalled: runtime.patchStatus.installed,
      splitFooterRendererPatchReason: runtime.patchStatus.reason,
      alternateScreen: config.alternateScreen,
      alternateScroll: config.alternateScroll,
      mouseScroll: config.mouseScroll,
      mouseWheelScrollRows: config.mouseWheelScrollRows,
      keyboardScroll: config.keyboardScroll,
      keyboardScrollRows: config.keyboardScrollRows,
      minimumHistoryRows: config.minimumHistoryRows,
      historyViewportLineLimit: config.historyViewportLineLimit,
      apiIntegration: "split-footer-renderer",
    });
  });

  pi.on("session_shutdown", (event) => {
    clearTerminalInputListener();
    resetStickySplitFooterViewport(getActiveStickyTerminalTui());

    if (event.reason === "quit") {
      return;
    }

    deactivateStickyTerminalSession((logEvent, fields) => runtime.logger.log(logEvent, fields));
  });
}
