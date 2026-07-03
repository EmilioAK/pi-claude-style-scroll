import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { loadStickyInputConfig } from "./config/config.js";

type MouseScrollCommandModule = typeof import("./commands/mouse-scroll-command.js");
type ConfigModule = typeof import("./config/config.js");
type DebugLoggerModule = typeof import("./logging/debug-logger.js");
type SplitFooterRendererModule = typeof import("./tui/split-footer-renderer.js");
type TerminalSessionModule = typeof import("./tui/terminal-session.js");
type StickyInputConfigLoadResult = import("./config/config.js").StickyInputConfigLoadResult;
type StickyInputConfig = import("./config/config.js").StickyInputConfig;
type DebugLogger = import("./logging/debug-logger.js").DebugLogger;
type StickySplitFooterPatchStatus = import("./tui/split-footer-renderer.js").StickySplitFooterPatchStatus;
type MouseWheelDirection = import("./tui/terminal-session.js").MouseWheelDirection;

const EXTENSION_ID = "pi-sticky-input";
const RUNTIME_PATCH_WIDGET_KEY = `${EXTENSION_ID}:runtime-renderer-hook`;
const DEFAULT_PATCH_STATUS: StickySplitFooterPatchStatus = {
  installed: false,
  active: false,
  reason: "not-loaded",
};

interface RuntimeState {
  configCwd: string | undefined;
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

/**
 * Lazily imports and caches a module, deduplicating concurrent in-flight imports.
 *
 * `cached` exposes the synchronously-resolved module (or `undefined`) so call
 * sites that only need already-loaded modules can short-circuit without awaiting.
 */
class ModuleLoader<T> {
  private module: T | undefined;
  private promise: Promise<T> | undefined;

  constructor(private readonly importer: () => Promise<T>) {}

  get cached(): T | undefined {
    return this.module;
  }

  load(): Promise<T> {
    if (this.module) {
      return Promise.resolve(this.module);
    }

    this.promise ??= this.importer().then((module) => {
      this.module = module;
      return module;
    });
    return this.promise;
  }
}

const mouseScrollCommandLoader = new ModuleLoader<MouseScrollCommandModule>(
  () => import("./commands/mouse-scroll-command.js"),
);
const configLoader = new ModuleLoader<ConfigModule>(() => import("./config/config.js"));
const debugLoggerLoader = new ModuleLoader<DebugLoggerModule>(() => import("./logging/debug-logger.js"));
const splitFooterRendererLoader = new ModuleLoader<SplitFooterRendererModule>(
  () => import("./tui/split-footer-renderer.js"),
);
const terminalSessionLoader = new ModuleLoader<TerminalSessionModule>(() => import("./tui/terminal-session.js"));

function loadMouseScrollCommandModule(): Promise<MouseScrollCommandModule> {
  return mouseScrollCommandLoader.load();
}

function loadConfigModule(): Promise<ConfigModule> {
  return configLoader.load();
}

function loadDebugLoggerModule(): Promise<DebugLoggerModule> {
  return debugLoggerLoader.load();
}

function loadSplitFooterRendererModule(): Promise<SplitFooterRendererModule> {
  return splitFooterRendererLoader.load();
}

function loadTerminalSessionModule(): Promise<TerminalSessionModule> {
  return terminalSessionLoader.load();
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

type StickyTerminalSessionOptions = import("./tui/terminal-session.js").StickyTerminalSessionOptions;

function createTerminalSessionOptions(configResult: StickyInputConfigLoadResult, logger: DebugLogger): StickyTerminalSessionOptions {
  const { config } = configResult;
  return {
    alternateScreen: config.alternateScreen,
    alternateScroll: config.alternateScroll,
    mouseScroll: config.mouseScroll,
    diagnostic: (event, fields) => logger.log(event, fields),
  };
}

/** Common mouse/keyboard scroll config fields shared across diagnostic log events. */
function scrollConfigFields(config: StickyInputConfig): Record<string, unknown> {
  return {
    alternateScreen: config.alternateScreen,
    alternateScroll: config.alternateScroll,
    mouseScroll: config.mouseScroll,
    mouseWheelScrollRows: config.mouseWheelScrollRows,
    keyboardScroll: config.keyboardScroll,
    keyboardScrollRows: config.keyboardScrollRows,
  };
}

async function createRuntimeState(cwd?: string): Promise<RuntimeState> {
  const [{ loadStickyInputConfig }, { DebugLogger }] = await Promise.all([
    loadConfigModule(),
    loadDebugLoggerModule(),
  ]);
  const configResult = loadStickyInputConfig({ cwd });
  const logger = DebugLogger.create(configResult.config);
  return {
    configCwd: cwd,
    configResult,
    logger,
    patchStatus: splitFooterRendererLoader.cached?.getStickySplitFooterPatchStatus() ?? DEFAULT_PATCH_STATUS,
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

function scrollAndLogWheelEvent(
  runtime: RuntimeState,
  splitFooterRenderer: SplitFooterRendererModule,
  tui: TUI | undefined,
  direction: MouseWheelDirection,
  mouseWheelScrollRows: number,
  event: string,
): void {
  const deltaRows = direction === "up" ? -mouseWheelScrollRows : mouseWheelScrollRows;
  const result = splitFooterRenderer.scrollStickySplitFooterViewport(tui, deltaRows);
  runtime.logger.log(event, {
    direction,
    deltaRows,
    handled: result.handled,
    changed: result.changed,
    viewportTop: result.viewportTop,
    followBottom: result.followBottom,
  });
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
      scrollAndLogWheelEvent(runtime, splitFooterRenderer, tui, direction, config.mouseWheelScrollRows, "terminal_alternate_scroll");
      return { consume: true };
    }
  }

  if (config.mouseScroll && terminalSession.isMouseInput(data)) {
    const direction = terminalSession.parseMouseWheelInput(data);
    if (direction) {
      scrollAndLogWheelEvent(runtime, splitFooterRenderer, tui, direction, config.mouseWheelScrollRows, "terminal_mouse_scroll");
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

  terminalSession.activateStickyTerminalSession(tui, createTerminalSessionOptions(runtime.configResult, runtime.logger));
}

async function installSplitFooterRendererHook(ctx: ExtensionContext, runtime: RuntimeState): Promise<void> {
  if (!ctx.hasUI) {
    return;
  }

  if (!getRendererEnabled(runtime.configResult)) {
    splitFooterRendererLoader.cached?.configureStickySplitFooterRenderer(createRendererOptions(runtime.configResult, runtime.logger));
    splitFooterRendererLoader.cached?.resetStickySplitFooterViewport(terminalSessionLoader.cached?.getActiveStickyTerminalTui());
    terminalSessionLoader.cached?.deactivateStickyTerminalSession((event, fields) => runtime.logger.log(event, fields));
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

      if (runtime.patchStatus.installed && runtime.patchStatus.active) {
        terminalSession.activateStickyTerminalSession(tui, createTerminalSessionOptions(runtime.configResult, runtime.logger));
      }

      const { config } = runtime.configResult;
      runtime.logger.log("split_footer_renderer_runtime_patch", {
        installed: runtime.patchStatus.installed,
        active: runtime.patchStatus.active,
        reason: runtime.patchStatus.reason,
        ...scrollConfigFields(config),
        startupRedrawFixCompatibility: "terminal-write-wrapper-safe",
      });
      return STICKY_RENDERER_HOOK_COMPONENT;
    },
    { placement: "belowEditor" },
  );
}

export default function stickyInputExtension(pi: ExtensionAPI): void {
  if (!loadStickyInputConfig().config.enabled) {
    return;
  }

  let runtime: RuntimeState | undefined;
  let pendingRuntime: Promise<RuntimeState> | undefined;
  let pendingRuntimeCwd: string | undefined;
  let unsubscribeTerminalInput: (() => void) | undefined;
  let terminalInputListenerGeneration = 0;

  async function refreshRuntimeState(cwd?: string): Promise<RuntimeState> {
    const nextRuntime = createRuntimeState(cwd);
    pendingRuntime = nextRuntime;
    pendingRuntimeCwd = cwd;
    try {
      runtime = await nextRuntime;
      return runtime;
    } finally {
      if (pendingRuntime === nextRuntime) {
        pendingRuntime = undefined;
        pendingRuntimeCwd = undefined;
      }
    }
  }

  function getRuntimeState(cwd?: string): Promise<RuntimeState> {
    if (runtime && runtime.configCwd === cwd) {
      return Promise.resolve(runtime);
    }

    if (pendingRuntime && pendingRuntimeCwd === cwd) {
      return pendingRuntime;
    }

    return refreshRuntimeState(cwd);
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

      const currentRuntime = await getRuntimeState(ctx.cwd);

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

    const currentRuntime = await refreshRuntimeState(ctx.cwd);
    await installSplitFooterRendererHook(ctx, currentRuntime);
    await installTerminalInputListener(ctx, currentRuntime);
  });

  pi.on("session_start", async (_event, ctx) => {
    const currentRuntime = await refreshRuntimeState(ctx.cwd);
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
      ...scrollConfigFields(config),
      minimumHistoryRows: config.minimumHistoryRows,
      historyViewportLineLimit: config.historyViewportLineLimit,
      apiIntegration: "split-footer-renderer",
    });
  });

  pi.on("session_shutdown", (event) => {
    clearTerminalInputListener();
    splitFooterRendererLoader.cached?.resetStickySplitFooterViewport(terminalSessionLoader.cached?.getActiveStickyTerminalTui());

    if (event.reason === "quit") {
      return;
    }

    terminalSessionLoader.cached?.deactivateStickyTerminalSession((logEvent, fields) => runtime?.logger.log(logEvent, fields));
  });
}
