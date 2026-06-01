import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

type MouseScrollCommandModule = typeof import("./commands/mouse-scroll-command.js");
type ConfigModule = typeof import("./config/config.js");
type DebugLoggerModule = typeof import("./logging/debug-logger.js");
type SplitFooterRendererModule = typeof import("./tui/split-footer-renderer.js");
type TerminalSessionModule = typeof import("./tui/terminal-session.js");
type StickyInputConfigLoadResult = import("./config/config.js").StickyInputConfigLoadResult;
type DebugLogger = import("./logging/debug-logger.js").DebugLogger;
type StickySplitFooterPatchStatus = import("./tui/split-footer-renderer.js").StickySplitFooterPatchStatus;

const EXTENSION_ID = "pi-sticky-input";
const RUNTIME_PATCH_WIDGET_KEY = `${EXTENSION_ID}:runtime-renderer-hook`;
const DEFAULT_PATCH_STATUS: StickySplitFooterPatchStatus = {
  installed: false,
  active: false,
  reason: "not-loaded",
};

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

const STICKY_RENDERER_HOOK_COMPONENT = new StickyRendererHookComponent();

let mouseScrollCommandModule: MouseScrollCommandModule | undefined;
let mouseScrollCommandModulePromise: Promise<MouseScrollCommandModule> | undefined;
let configModule: ConfigModule | undefined;
let configModulePromise: Promise<ConfigModule> | undefined;
let debugLoggerModule: DebugLoggerModule | undefined;
let debugLoggerModulePromise: Promise<DebugLoggerModule> | undefined;
let splitFooterRendererModule: SplitFooterRendererModule | undefined;
let splitFooterRendererModulePromise: Promise<SplitFooterRendererModule> | undefined;
let terminalSessionModule: TerminalSessionModule | undefined;
let terminalSessionModulePromise: Promise<TerminalSessionModule> | undefined;

function loadMouseScrollCommandModule(): Promise<MouseScrollCommandModule> {
  if (mouseScrollCommandModule) {
    return Promise.resolve(mouseScrollCommandModule);
  }

  mouseScrollCommandModulePromise ??= import("./commands/mouse-scroll-command.js")
    .then((module) => {
      mouseScrollCommandModule = module;
      return module;
    });
  return mouseScrollCommandModulePromise;
}

function loadConfigModule(): Promise<ConfigModule> {
  if (configModule) {
    return Promise.resolve(configModule);
  }

  configModulePromise ??= import("./config/config.js")
    .then((module) => {
      configModule = module;
      return module;
    });
  return configModulePromise;
}

function loadDebugLoggerModule(): Promise<DebugLoggerModule> {
  if (debugLoggerModule) {
    return Promise.resolve(debugLoggerModule);
  }

  debugLoggerModulePromise ??= import("./logging/debug-logger.js")
    .then((module) => {
      debugLoggerModule = module;
      return module;
    });
  return debugLoggerModulePromise;
}

function loadSplitFooterRendererModule(): Promise<SplitFooterRendererModule> {
  if (splitFooterRendererModule) {
    return Promise.resolve(splitFooterRendererModule);
  }

  splitFooterRendererModulePromise ??= import("./tui/split-footer-renderer.js")
    .then((module) => {
      splitFooterRendererModule = module;
      return module;
    });
  return splitFooterRendererModulePromise;
}

function loadTerminalSessionModule(): Promise<TerminalSessionModule> {
  if (terminalSessionModule) {
    return Promise.resolve(terminalSessionModule);
  }

  terminalSessionModulePromise ??= import("./tui/terminal-session.js")
    .then((module) => {
      terminalSessionModule = module;
      return module;
    });
  return terminalSessionModulePromise;
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

async function createRuntimeState(): Promise<RuntimeState> {
  const [{ loadStickyInputConfig }, { DebugLogger }] = await Promise.all([
    loadConfigModule(),
    loadDebugLoggerModule(),
  ]);
  const configResult = loadStickyInputConfig();
  const logger = DebugLogger.create(configResult.config);
  return {
    configResult,
    logger,
    patchStatus: splitFooterRendererModule?.getStickySplitFooterPatchStatus() ?? DEFAULT_PATCH_STATUS,
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
  terminalSession: TerminalSessionModule,
  splitFooterRenderer: SplitFooterRendererModule,
  data: string,
  getEditorText?: () => string,
): { consume?: boolean; data?: string } | undefined {
  const { config } = runtime.configResult;
  const tui = terminalSession.getActiveStickyTerminalTui();

  if (!terminalSession.shouldHandleStickyTerminalInput(tui)) {
    return undefined;
  }

  const editorTextEmpty = isEditorTextEmpty(getEditorText);

  if (config.alternateScroll) {
    const direction = terminalSession.parseAlternateScrollInput(data, { allowCursorKeys: editorTextEmpty });
    if (direction) {
      const deltaRows = direction === "up" ? -config.mouseWheelScrollRows : config.mouseWheelScrollRows;
      const result = splitFooterRenderer.scrollStickySplitFooterViewport(tui, deltaRows);
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

  if (config.mouseScroll && terminalSession.isMouseInput(data)) {
    const direction = terminalSession.parseMouseWheelInput(data);
    if (direction) {
      const deltaRows = direction === "up" ? -config.mouseWheelScrollRows : config.mouseWheelScrollRows;
      const result = splitFooterRenderer.scrollStickySplitFooterViewport(tui, deltaRows);
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
    ? terminalSession.getKeyboardScrollRows(data, config.keyboardScrollRows, { allowPlainHomeEnd: editorTextEmpty })
    : undefined;
  if (keyboardScrollRows !== undefined) {
    const result = splitFooterRenderer.scrollStickySplitFooterViewport(tui, keyboardScrollRows);
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

async function applyRuntimeMouseScrollMode(
  runtime: RuntimeState,
  command: MouseScrollCommandModule,
  enabled: boolean,
): Promise<void> {
  const { config } = runtime.configResult;
  command.applyStickyMouseScrollMode(config, enabled);

  if (!getRendererEnabled(runtime.configResult)) {
    return;
  }

  const terminalSession = await loadTerminalSessionModule();
  const tui = terminalSession.getActiveStickyTerminalTui();
  if (!tui) {
    return;
  }

  terminalSession.activateStickyTerminalSession(tui, {
    alternateScreen: config.alternateScreen,
    alternateScroll: config.alternateScroll,
    mouseScroll: config.mouseScroll,
    diagnostic: (event, fields) => runtime.logger.log(event, fields),
  });
}

async function installSplitFooterRendererHook(ctx: ExtensionContext, runtime: RuntimeState): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  if (!getRendererEnabled(runtime.configResult)) {
    splitFooterRendererModule?.configureStickySplitFooterRenderer(createRendererOptions(runtime.configResult, runtime.logger));
    splitFooterRendererModule?.resetStickySplitFooterViewport(terminalSessionModule?.getActiveStickyTerminalTui());
    terminalSessionModule?.deactivateStickyTerminalSession((event, fields) => runtime.logger.log(event, fields));
    ctx.ui.setWidget(RUNTIME_PATCH_WIDGET_KEY, undefined);
    return;
  }

  const [splitFooterRenderer, terminalSession] = await Promise.all([
    loadSplitFooterRendererModule(),
    loadTerminalSessionModule(),
  ]);
  const patchedTuis = new WeakSet<object>();

  ctx.ui.setWidget(
    RUNTIME_PATCH_WIDGET_KEY,
    (tui: TUI) => {
      if (patchedTuis.has(tui as unknown as object)) {
        return STICKY_RENDERER_HOOK_COMPONENT;
      }

      patchedTuis.add(tui as unknown as object);
      runtime.patchStatus = splitFooterRenderer.applyStickySplitFooterRendererPatch(
        createRendererOptions(runtime.configResult, runtime.logger),
        tui,
      );

      const { config } = runtime.configResult;
      if (runtime.patchStatus.installed && runtime.patchStatus.active) {
        terminalSession.activateStickyTerminalSession(tui, {
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
      return STICKY_RENDERER_HOOK_COMPONENT;
    },
    { placement: "belowEditor" },
  );
}

export default function stickyInputExtension(pi: ExtensionAPI): void {
  let runtime: RuntimeState | undefined;
  let pendingRuntime: Promise<RuntimeState> | undefined;
  let unsubscribeTerminalInput: (() => void) | undefined;
  let terminalInputListenerGeneration = 0;

  async function refreshRuntimeState(): Promise<RuntimeState> {
    const nextRuntime = createRuntimeState();
    pendingRuntime = nextRuntime;
    try {
      runtime = await nextRuntime;
      return runtime;
    } finally {
      if (pendingRuntime === nextRuntime) {
        pendingRuntime = undefined;
      }
    }
  }

  function getRuntimeState(): Promise<RuntimeState> {
    if (runtime) {
      return Promise.resolve(runtime);
    }

    if (pendingRuntime) {
      return pendingRuntime;
    }

    return refreshRuntimeState();
  }

  pi.registerCommand("sticky-input", {
    description: "Toggle pi-sticky-input mouse-wheel chat scrolling.",
    handler: async (args, ctx) => {
      const command = await loadMouseScrollCommandModule();
      const action = command.parseStickyInputCommandArgs(args);
      if (action.type === "error") {
        ctx.ui.notify(action.message, "warning");
        return;
      }

      if (action.type === "help") {
        ctx.ui.notify(command.getStickyInputCommandHelp(), "info");
        return;
      }

      const currentRuntime = await getRuntimeState();

      if (action.type === "status") {
        ctx.ui.notify(command.getStickyMouseScrollStatusMessage(currentRuntime.configResult.config.mouseScroll), "info");
        return;
      }

      const enabled = action.type === "toggle" ? !currentRuntime.configResult.config.mouseScroll : action.enabled;
      await applyRuntimeMouseScrollMode(currentRuntime, command, enabled);
      currentRuntime.logger.log("mouse_scroll_command", {
        enabled,
        alternateScroll: currentRuntime.configResult.config.alternateScroll,
      });
      ctx.ui.notify(command.getStickyMouseScrollStatusMessage(enabled), "info");
    },
  });

  function clearTerminalInputListener(): void {
    terminalInputListenerGeneration += 1;
    unsubscribeTerminalInput?.();
    unsubscribeTerminalInput = undefined;
  }

  async function installTerminalInputListener(ctx: ExtensionContext, currentRuntime: RuntimeState): Promise<void> {
    clearTerminalInputListener();

    const { config } = currentRuntime.configResult;
    if (
      !ctx.hasUI
      || !getRendererEnabled(currentRuntime.configResult)
      || (!config.alternateScroll && !config.mouseScroll && !config.keyboardScroll)
    ) {
      return;
    }

    const generation = terminalInputListenerGeneration;
    const [terminalSession, splitFooterRenderer] = await Promise.all([
      loadTerminalSessionModule(),
      loadSplitFooterRendererModule(),
    ]);
    if (generation !== terminalInputListenerGeneration) {
      return;
    }

    unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => handleStickyTerminalInput(
      currentRuntime,
      terminalSession,
      splitFooterRenderer,
      data,
      () => ctx.ui.getEditorText(),
    ));
  }

  pi.on("resources_discover", async (event, ctx) => {
    if (event.reason !== "reload") {
      return;
    }

    const currentRuntime = await refreshRuntimeState();
    await installSplitFooterRendererHook(ctx, currentRuntime);
    await installTerminalInputListener(ctx, currentRuntime);
  });

  pi.on("session_start", async (_event, ctx) => {
    const currentRuntime = await refreshRuntimeState();
    const { config } = currentRuntime.configResult;

    notifyWarnings(ctx, currentRuntime.configResult.warnings);
    await installSplitFooterRendererHook(ctx, currentRuntime);
    await installTerminalInputListener(ctx, currentRuntime);
    currentRuntime.logger.log("session_start", {
      enabled: config.enabled,
      hasUI: ctx.hasUI,
      splitFooterRenderer: config.splitFooterRenderer,
      splitFooterRendererActive: currentRuntime.patchStatus.active,
      splitFooterRendererPatchInstalled: currentRuntime.patchStatus.installed,
      splitFooterRendererPatchReason: currentRuntime.patchStatus.reason,
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
    splitFooterRendererModule?.resetStickySplitFooterViewport(terminalSessionModule?.getActiveStickyTerminalTui());

    if (event.reason === "quit") {
      return;
    }

    terminalSessionModule?.deactivateStickyTerminalSession((logEvent, fields) => runtime?.logger.log(logEvent, fields));
  });
}
