import {
  CURSOR_MARKER,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type Terminal,
} from "@earendil-works/pi-tui";

export type StickySplitFooterDiagnostic = (event: string, fields: Record<string, unknown>) => void;

export interface StickySplitFooterViewportStatus {
  active: boolean;
  atBottom: boolean;
  followBottom: boolean;
  viewportTop: number;
  minimumViewportTop: number;
  maximumViewportTop: number;
  historyRows: number;
  historyLineCount: number;
}

export type StickySplitFooterViewportStatusChange = (status: StickySplitFooterViewportStatus | undefined) => void;

export interface StickySplitFooterRendererOptions {
  enabled: boolean;
  minimumHistoryRows: number;
  historyViewportLineLimit: number;
  diagnostic?: StickySplitFooterDiagnostic;
  onViewportStatusChange?: StickySplitFooterViewportStatusChange;
}

export interface StickySplitFooterPatchStatus {
  installed: boolean;
  active: boolean;
  reason: string;
}

interface CursorPosition {
  row: number;
  col: number;
}

interface TuiWithInternals {
  children: Component[];
  terminal: Terminal;
  previousLines: string[];
  previousWidth: number;
  previousHeight: number;
  cursorRow: number;
  hardwareCursorRow: number;
  clearOnShrink: boolean;
  maxLinesRendered: number;
  previousViewportTop: number;
  fullRedrawCount: number;
  stopped: boolean;
  overlayStack: unknown[];
  hasOverlay?: () => boolean;
  extractCursorPosition?: (lines: string[], height: number) => CursorPosition | null;
  applyLineResets?: (lines: string[]) => string[];
  positionHardwareCursor?: (cursorPos: CursorPosition | null, totalLines: number) => void;
}

type DoRender = (this: TUI) => void;

interface PatchedTuiPrototype {
  doRender?: DoRender;
  __piStickyInputOriginalDoRender?: DoRender;
  __piStickyInputPatched?: boolean;
}

interface ChildRange {
  start: number;
  end: number;
}

interface RenderedChildren {
  lines: string[];
  ranges: ChildRange[];
}

interface SplitLayout {
  lines: string[];
  footerStartLine: number;
  stickyRows: number;
  historyRows: number;
  historyViewportTop: number;
  screenLines: string[];
}

interface ViewportMetadata {
  footerStartLine: number;
  stickyRows: number;
  historyRows: number;
  historyViewportTop: number;
  logicalLineCount: number;
}

interface HistoryViewportState {
  viewportTop: number;
  followBottom: boolean;
}

interface LineSpan {
  start: number;
  endExclusive: number;
}

export interface StickySplitFooterScrollResult {
  handled: boolean;
  changed: boolean;
  viewportTop?: number;
  followBottom?: boolean;
}

interface UnsupportedLayout {
  reason: string;
  fields?: Record<string, unknown>;
}

const DEFAULT_OPTIONS: StickySplitFooterRendererOptions = {
  enabled: false,
  minimumHistoryRows: 3,
  historyViewportLineLimit: 200,
};

const STICKY_PANE_CHILD_COUNT = 5;
const SIXEL_RENDER_ROW_MARKER = "\x1b_Gm=0;\x1b\\";
const INLINE_IMAGE_PROTOCOL_MARKERS = [
  SIXEL_RENDER_ROW_MARKER,
  "\x1b_G", // Kitty graphics APC.
  "\x1b]1337;File=", // iTerm2 inline image OSC.
  "\x1bP", // Sixel DCS.
] as const;
const CURSOR_UP_ROWS_PATTERN = /\x1b\[(\d+)A/g;

let options: StickySplitFooterRendererOptions = { ...DEFAULT_OPTIONS };
let patchInstalled = false;
let lastPatchReason = "not-installed";
let viewportStatusKeys = new WeakMap<object, string>();

const viewportMetadata = new WeakMap<object, ViewportMetadata>();
const historyViewportState = new WeakMap<object, HistoryViewportState>();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function getTuiInternals(tui: TUI): TuiWithInternals {
  return tui as unknown as TuiWithInternals;
}

function hasRequiredInternals(tui: TuiWithInternals): boolean {
  return Array.isArray(tui.children)
    && Array.isArray(tui.previousLines)
    && Array.isArray(tui.overlayStack)
    && typeof tui.extractCursorPosition === "function"
    && typeof tui.applyLineResets === "function"
    && typeof tui.positionHardwareCursor === "function"
    && typeof tui.terminal?.write === "function"
    && typeof tui.terminal.columns === "number"
    && typeof tui.terminal.rows === "number";
}

function getVisibleOverlayState(tui: TuiWithInternals): boolean {
  if (typeof tui.hasOverlay === "function") {
    return tui.hasOverlay();
  }

  return Array.isArray(tui.overlayStack) && tui.overlayStack.length > 0;
}

function getUnsupportedTerminalReason(tui: TuiWithInternals): UnsupportedLayout | undefined {
  const width = tui.terminal.columns;
  const height = tui.terminal.rows;

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return { reason: "invalid-terminal-dimensions", fields: { width, height } };
  }

  if (width < 20 || height < 8) {
    return { reason: "terminal-too-small", fields: { width, height } };
  }

  if (process.env.TERM === "dumb") {
    return { reason: "dumb-terminal" };
  }

  if ((process.env.PI_CLAUDE_STYLE_SCROLL_DISABLE_SPLIT_FOOTER === "1" || process.env.PI_STICKY_INPUT_DISABLE_SPLIT_FOOTER === "1")) {
    return { reason: "disabled-by-environment" };
  }

  return undefined;
}

function findStickyPaneStartIndex(tui: TuiWithInternals): number {
  return tui.children.length >= STICKY_PANE_CHILD_COUNT
    ? tui.children.length - STICKY_PANE_CHILD_COUNT
    : -1;
}

function isPlainContainer(component: Component): component is Component & { children: Component[] } {
  return component.constructor?.name === "Container" && Array.isArray((component as { children?: unknown }).children);
}

function renderComponent(component: Component, width: number): string[] {
  if (!isPlainContainer(component)) {
    return component.render(width);
  }

  const lines: string[] = [];
  for (const child of component.children) {
    lines.push(...renderComponent(child, width));
  }
  return lines;
}

function renderChildren(tui: TuiWithInternals, width: number): RenderedChildren {
  const ranges: ChildRange[] = [];
  const lines: string[] = [];

  for (const child of tui.children) {
    const start = lines.length;
    lines.push(...renderComponent(child, width));
    ranges.push({ start, end: lines.length });
  }

  return { lines, ranges };
}

function getRetainedHistoryBounds(
  historyLineCount: number,
  historyRows: number,
): { minimumViewportTop: number; maximumViewportTop: number } {
  const maximumViewportTop = Math.max(0, historyLineCount - historyRows);
  const minimumViewportTop = options.historyViewportLineLimit < DEFAULT_OPTIONS.historyViewportLineLimit
    ? Math.max(0, historyLineCount - options.historyViewportLineLimit - historyRows)
    : 0;
  return { minimumViewportTop, maximumViewportTop };
}

function getHistoryViewportTop(
  tui: object,
  historyLineCount: number,
  historyRows: number,
): { viewportTop: number; followBottom: boolean } {
  const { minimumViewportTop, maximumViewportTop } = getRetainedHistoryBounds(historyLineCount, historyRows);
  const state = historyViewportState.get(tui);

  if (!state || state.followBottom) {
    const nextState = { viewportTop: maximumViewportTop, followBottom: true };
    historyViewportState.set(tui, nextState);
    return nextState;
  }

  const viewportTop = clamp(state.viewportTop, minimumViewportTop, maximumViewportTop);
  const followBottom = viewportTop >= maximumViewportTop;
  const nextState = { viewportTop, followBottom };
  historyViewportState.set(tui, nextState);
  return nextState;
}

function getInlineImageMoveUpRows(line: string): number {
  if (!isInlineImageProtocolLine(line)) {
    return 0;
  }

  let rows = 0;
  for (const match of line.matchAll(CURSOR_UP_ROWS_PATTERN)) {
    rows = Math.max(rows, Number.parseInt(match[1] ?? "0", 10));
  }

  return rows;
}

function countPrecedingBlankSpacerRows(lines: readonly string[], row: number, limit: number): number {
  let spacerRows = 0;

  while (spacerRows < limit) {
    const candidateRow = row - spacerRows - 1;
    if (candidateRow < 0 || (lines[candidateRow] ?? "") !== "") {
      break;
    }

    spacerRows += 1;
  }

  return spacerRows;
}

function isInlineImageProtocolLine(line: string): boolean {
  return INLINE_IMAGE_PROTOCOL_MARKERS.some((marker) => line.includes(marker));
}

function getInlineImageSpanEndingAt(lines: readonly string[], row: number): LineSpan | undefined {
  const line = lines[row] ?? "";
  if (!isInlineImageProtocolLine(line)) {
    return undefined;
  }

  const spacerRows = countPrecedingBlankSpacerRows(lines, row, getInlineImageMoveUpRows(line));
  return { start: row - spacerRows, endExclusive: row + 1 };
}

function collectInlineImageSpans(lines: readonly string[]): LineSpan[] {
  const spans: LineSpan[] = [];

  for (let row = 0; row < lines.length; row += 1) {
    const span = getInlineImageSpanEndingAt(lines, row);
    if (span) {
      spans.push(span);
    }
  }

  return spans;
}

function findContainingLineSpan(spans: readonly LineSpan[], row: number): LineSpan | undefined {
  return spans.find((span) => span.start <= row && row < span.endExclusive);
}

function lineSpanContentMatches(
  previousLines: readonly string[],
  previousSpan: LineSpan,
  nextLines: readonly string[],
  nextSpan: LineSpan,
): boolean {
  const previousSpanRows = previousSpan.endExclusive - previousSpan.start;
  const nextSpanRows = nextSpan.endExclusive - nextSpan.start;
  if (previousSpanRows !== nextSpanRows) {
    return false;
  }

  for (let offset = 0; offset < previousSpanRows; offset += 1) {
    if ((previousLines[previousSpan.start + offset] ?? "") !== (nextLines[nextSpan.start + offset] ?? "")) {
      return false;
    }
  }

  return true;
}

function alignViewportTopToInlineImageSpans(
  historyLines: readonly string[],
  viewportTop: number,
  historyRows: number,
): { viewportTop: number; unsupportedSpan?: LineSpan } {
  const maximumViewportTop = Math.max(0, historyLines.length - historyRows);
  const spans = collectInlineImageSpans(historyLines);
  let nextViewportTop = clamp(viewportTop, 0, maximumViewportTop);

  for (let iteration = 0; iteration <= spans.length; iteration += 1) {
    const viewportBottom = nextViewportTop + historyRows;
    const oversizedSpan = spans.find(
      (span) => span.endExclusive - span.start > historyRows
        && span.start < viewportBottom
        && nextViewportTop < span.endExclusive,
    );
    if (oversizedSpan) {
      return { viewportTop: nextViewportTop, unsupportedSpan: oversizedSpan };
    }

    const leadingSpan = spans.find((span) => span.start < nextViewportTop && nextViewportTop < span.endExclusive);
    if (leadingSpan) {
      nextViewportTop = leadingSpan.start;
      continue;
    }

    const trailingSpan = spans.find((span) => span.start < viewportBottom && viewportBottom < span.endExclusive);
    if (trailingSpan) {
      nextViewportTop = clamp(trailingSpan.endExclusive - historyRows, 0, maximumViewportTop);
      continue;
    }

    break;
  }

  return { viewportTop: nextViewportTop };
}

function createScreenLines(
  tui: object,
  historyLines: readonly string[],
  stickyLines: readonly string[],
  historyRows: number,
): { screenLines: string[]; historyViewportTop: number } | UnsupportedLayout {
  const { viewportTop, followBottom } = getHistoryViewportTop(tui, historyLines.length, historyRows);
  const alignedViewport = alignViewportTopToInlineImageSpans(historyLines, viewportTop, historyRows);
  if (alignedViewport.unsupportedSpan) {
    return {
      reason: "history-inline-image-span-too-tall",
      fields: {
        historyRows,
        viewportTop,
        spanStart: alignedViewport.unsupportedSpan.start,
        spanEndExclusive: alignedViewport.unsupportedSpan.endExclusive,
        spanRows: alignedViewport.unsupportedSpan.endExclusive - alignedViewport.unsupportedSpan.start,
      },
    };
  }

  const historyViewportTop = alignedViewport.viewportTop;
  const { maximumViewportTop } = getRetainedHistoryBounds(historyLines.length, historyRows);
  historyViewportState.set(tui, {
    viewportTop: historyViewportTop,
    followBottom: followBottom || historyViewportTop >= maximumViewportTop,
  });

  const visibleHistory = historyLines.slice(historyViewportTop, historyViewportTop + historyRows);
  const screenLines = [...visibleHistory];

  while (screenLines.length < historyRows) {
    screenLines.push("");
  }

  screenLines.push(...stickyLines);
  return { screenLines, historyViewportTop };
}

function normalizeVisibleLine(line: string, width: number): string {
  if (isInlineImageProtocolLine(line)) {
    return line;
  }

  return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
}

function normalizeVisibleLines(lines: readonly string[], width: number): string[] {
  return lines.map((line) => normalizeVisibleLine(line, width));
}

function buildSplitLayout(tui: TuiWithInternals, width: number, height: number): SplitLayout | UnsupportedLayout {
  const footerStartIndex = findStickyPaneStartIndex(tui);
  if (footerStartIndex < 0) {
    return {
      reason: "unknown-layout",
      fields: {
        childCount: tui.children.length,
        expectedStickyPaneChildCount: STICKY_PANE_CHILD_COUNT,
      },
    };
  }

  const rendered = renderChildren(tui, width);
  const footerStartLine = rendered.ranges[footerStartIndex]?.start;
  if (footerStartLine === undefined) {
    return { reason: "missing-footer-start-range", fields: { footerStartIndex } };
  }

  const stickyRows = rendered.lines.length - footerStartLine;
  if (stickyRows <= 0) {
    return { reason: "empty-sticky-pane", fields: { footerStartIndex, footerStartLine } };
  }

  if (stickyRows >= height) {
    return { reason: "sticky-pane-too-tall", fields: { stickyRows, height } };
  }

  const historyRows = height - stickyRows;
  if (historyRows < options.minimumHistoryRows) {
    return {
      reason: "history-pane-too-small",
      fields: { historyRows, stickyRows, height, minimumHistoryRows: options.minimumHistoryRows },
    };
  }

  const historyLines = rendered.lines.slice(0, footerStartLine);
  const stickyLines = rendered.lines.slice(footerStartLine);
  const screen = createScreenLines(tui, historyLines, stickyLines, historyRows);
  if (isUnsupportedLayout(screen)) {
    return screen;
  }

  const { screenLines, historyViewportTop } = screen;

  return {
    lines: rendered.lines,
    footerStartLine,
    stickyRows,
    historyRows,
    historyViewportTop,
    screenLines,
  };
}

function isUnsupportedLayout(layout: object): layout is UnsupportedLayout {
  return "reason" in layout && typeof (layout as { reason?: unknown }).reason === "string";
}

function extractCursorPosition(lines: string[], height: number): CursorPosition | null {
  const viewportTop = Math.max(0, lines.length - height);
  for (let row = lines.length - 1; row >= viewportTop; row -= 1) {
    const line = lines[row] ?? "";
    const markerIndex = line.indexOf(CURSOR_MARKER);
    if (markerIndex === -1) {
      continue;
    }

    const beforeMarker = line.slice(0, markerIndex);
    const col = visibleWidth(beforeMarker);
    lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
    return { row, col };
  }

  return null;
}

function beginSynchronizedOutput(): string {
  return "\x1b[?2026h";
}

function endSynchronizedOutput(): string {
  return "\x1b[?2026l";
}

function clearViewportForStartupRedrawCompatibility(): string {
  return "\x1b[H\x1b[2J";
}

function moveTo(row: number, column: number): string {
  return `\x1b[${row};${column}H`;
}

function clearWholeLine(): string {
  return "\x1b[2K";
}

function clearToLineEnd(): string {
  return "\x1b[K";
}

function clearToLineEndIfNeeded(line: string, width: number): string {
  if (isInlineImageProtocolLine(line)) {
    return "";
  }

  return visibleWidth(line) < width ? clearToLineEnd() : "";
}

function logDiagnostic(event: string, fields: Record<string, unknown>): void {
  options.diagnostic?.(event, fields);
}

function rememberMetadata(tui: object, layout: SplitLayout): void {
  viewportMetadata.set(tui, {
    footerStartLine: layout.footerStartLine,
    stickyRows: layout.stickyRows,
    historyRows: layout.historyRows,
    historyViewportTop: layout.historyViewportTop,
    logicalLineCount: layout.lines.length,
  });
}

function createViewportStatus(tui: object, layout: SplitLayout): StickySplitFooterViewportStatus {
  const { minimumViewportTop, maximumViewportTop } = getRetainedHistoryBounds(layout.footerStartLine, layout.historyRows);
  const state = historyViewportState.get(tui);
  const followBottom = state?.followBottom ?? layout.historyViewportTop >= maximumViewportTop;

  return {
    active: true,
    atBottom: followBottom || layout.historyViewportTop >= maximumViewportTop,
    followBottom,
    viewportTop: layout.historyViewportTop,
    minimumViewportTop,
    maximumViewportTop,
    historyRows: layout.historyRows,
    historyLineCount: layout.footerStartLine,
  };
}

function getViewportStatusKey(status: StickySplitFooterViewportStatus | undefined): string {
  if (!status) {
    return "inactive";
  }

  return [
    status.active ? "active" : "inactive",
    status.atBottom ? "bottom" : "scrolled",
    status.followBottom ? "follow" : "pinned",
    status.viewportTop,
    status.minimumViewportTop,
    status.maximumViewportTop,
    status.historyRows,
    status.historyLineCount,
  ].join(":");
}

function notifyViewportStatus(tui: object, status: StickySplitFooterViewportStatus | undefined): void {
  const key = getViewportStatusKey(status);
  if (viewportStatusKeys.get(tui) === key) {
    return;
  }

  viewportStatusKeys.set(tui, key);
  options.onViewportStatusChange?.(status);
}

function updateRenderState(
  tui: TuiWithInternals,
  screenLines: string[],
  width: number,
  height: number,
  hardwareCursorRow?: number,
): void {
  tui.cursorRow = Math.max(0, screenLines.length - 1);
  if (hardwareCursorRow !== undefined) {
    tui.hardwareCursorRow = clamp(hardwareCursorRow, 0, Math.max(0, screenLines.length - 1));
  }
  tui.maxLinesRendered = Math.max(tui.maxLinesRendered, screenLines.length);
  tui.previousViewportTop = 0;
  tui.previousLines = screenLines;
  tui.previousWidth = width;
  tui.previousHeight = height;
}

function collectInlineImageSpanSets(
  previousLines: readonly string[],
  screenLines: readonly string[],
): { previousSpans: LineSpan[]; nextSpans: LineSpan[]; bothEmpty: boolean } {
  const previousSpans = collectInlineImageSpans(previousLines);
  const nextSpans = collectInlineImageSpans(screenLines);
  return { previousSpans, nextSpans, bothEmpty: previousSpans.length === 0 && nextSpans.length === 0 };
}

function expandRowsToRenderForInlineImageSpans(
  previousLines: readonly string[],
  screenLines: readonly string[],
  rowsToRender: readonly number[],
): number[] {
  if (rowsToRender.length === 0) {
    return [];
  }

  const { previousSpans, nextSpans, bothEmpty } = collectInlineImageSpanSets(previousLines, screenLines);
  if (bothEmpty) {
    return [...rowsToRender];
  }

  const expandedRows = new Set(rowsToRender);
  for (const row of rowsToRender) {
    for (const spans of [previousSpans, nextSpans]) {
      const span = findContainingLineSpan(spans, row);
      if (!span) {
        continue;
      }

      for (let spanRow = span.start; spanRow < span.endExclusive; spanRow += 1) {
        expandedRows.add(spanRow);
      }
    }
  }

  return [...expandedRows].sort((left, right) => left - right);
}

function getRowsToRender(
  previousLines: readonly string[],
  screenLines: readonly string[],
  forceFullRender: boolean,
): number[] {
  if (forceFullRender) {
    return screenLines.map((_line, index) => index);
  }

  const rows: number[] = [];
  const rowCount = Math.max(previousLines.length, screenLines.length);
  for (let row = 0; row < rowCount; row += 1) {
    if ((previousLines[row] ?? "") !== (screenLines[row] ?? "")) {
      rows.push(row);
    }
  }

  return expandRowsToRenderForInlineImageSpans(previousLines, screenLines, rows);
}

function renderBoundedViewport(
  tui: TuiWithInternals,
  layout: SplitLayout,
  cursorPos: CursorPosition | null,
  width: number,
  height: number,
  clear: boolean,
): void {
  tui.fullRedrawCount += clear ? 1 : 0;

  const rowsToRender = getRowsToRender(tui.previousLines, layout.screenLines, clear);
  let hardwareCursorRow = tui.hardwareCursorRow;

  if (rowsToRender.length > 0) {
    let buffer = beginSynchronizedOutput();
    if (clear) {
      buffer += `\x1b[r${clearViewportForStartupRedrawCompatibility()}`;
    }

    for (const screenRow of rowsToRender) {
      const line = layout.screenLines[screenRow] ?? "";
      buffer += clear
        ? `${moveTo(screenRow + 1, 1)}${clearWholeLine()}${line}`
        : `${moveTo(screenRow + 1, 1)}${line}${clearToLineEndIfNeeded(line, width)}`;
      hardwareCursorRow = screenRow;
    }

    buffer += endSynchronizedOutput();
    tui.terminal.write(buffer);
  }

  updateRenderState(tui, layout.screenLines, width, height, hardwareCursorRow);
  tui.positionHardwareCursor?.(cursorPos, layout.screenLines.length);
  rememberMetadata(tui, layout);
  notifyViewportStatus(tui as unknown as object, createViewportStatus(tui as unknown as object, layout));
}

function forceOriginalRenderer(
  tui: TuiWithInternals,
  originalDoRender: DoRender,
  thisArg: TUI,
  reason: string,
  fields: Record<string, unknown> = {},
): void {
  const leavingStickyRenderer = viewportMetadata.has(thisArg);
  viewportMetadata.delete(thisArg);
  logDiagnostic("fallback", {
    reason,
    width: tui.terminal?.columns,
    height: tui.terminal?.rows,
    previousScreenRows: tui.previousLines.length,
    leavingStickyRenderer,
    ...fields,
  });

  if (leavingStickyRenderer) {
    notifyViewportStatus(thisArg as unknown as object, undefined);
    tui.previousLines = [];
    tui.previousWidth = -1;
    tui.previousHeight = -1;
    tui.cursorRow = 0;
    tui.hardwareCursorRow = 0;
    tui.previousViewportTop = 0;
  }

  originalDoRender.call(thisArg);
}

function handOffToOriginalRenderer(tui: TuiWithInternals, originalDoRender: DoRender, thisArg: TUI): void {
  if (viewportMetadata.has(thisArg)) {
    forceOriginalRenderer(tui, originalDoRender, thisArg, "sticky-renderer-disabled");
    return;
  }

  originalDoRender.call(thisArg);
}

function shouldForceFullClearForInlineImageSpans(
  previousLines: readonly string[],
  screenLines: readonly string[],
): boolean {
  const { previousSpans, nextSpans, bothEmpty } = collectInlineImageSpanSets(previousLines, screenLines);
  if (bothEmpty) {
    return false;
  }

  if (previousSpans.length !== nextSpans.length) {
    return true;
  }

  return previousSpans.some((span, index) => {
    const nextSpan = nextSpans[index];
    return !nextSpan
      || span.start !== nextSpan.start
      || span.endExclusive !== nextSpan.endExclusive
      || !lineSpanContentMatches(previousLines, span, screenLines, nextSpan);
  });
}

function shouldClearViewport(
  tui: TuiWithInternals,
  width: number,
  height: number,
  screenLines: readonly string[],
): boolean {
  return tui.previousLines.length === 0
    || tui.previousWidth !== width
    || tui.previousHeight !== height
    || !viewportMetadata.has(tui as unknown as object)
    || shouldForceFullClearForInlineImageSpans(tui.previousLines, screenLines);
}

function patchedDoRender(this: TUI): void {
  const tui = getTuiInternals(this);
  const prototype = Object.getPrototypeOf(this) as PatchedTuiPrototype | null;
  const originalDoRender = prototype?.__piStickyInputOriginalDoRender;

  if (!originalDoRender) {
    return;
  }

  if (!options.enabled || tui.stopped) {
    handOffToOriginalRenderer(tui, originalDoRender, this);
    return;
  }

  if (!hasRequiredInternals(tui)) {
    forceOriginalRenderer(tui, originalDoRender, this, "missing-required-tui-internals", {
      hasChildren: Array.isArray(tui.children),
      hasPreviousLines: Array.isArray(tui.previousLines),
      hasOverlayStack: Array.isArray(tui.overlayStack),
    });
    return;
  }

  const unsupportedTerminal = getUnsupportedTerminalReason(tui);
  if (unsupportedTerminal) {
    forceOriginalRenderer(tui, originalDoRender, this, unsupportedTerminal.reason, unsupportedTerminal.fields);
    return;
  }

  if (getVisibleOverlayState(tui)) {
    forceOriginalRenderer(tui, originalDoRender, this, "visible-overlay", {
      overlayCount: tui.overlayStack.length,
    });
    return;
  }

  const width = tui.terminal.columns;
  const height = tui.terminal.rows;
  const layout = buildSplitLayout(tui, width, height);

  if (isUnsupportedLayout(layout)) {
    forceOriginalRenderer(tui, originalDoRender, this, layout.reason, layout.fields);
    return;
  }

  const cursorPos = extractCursorPosition(layout.screenLines, height);
  const appliedLines = tui.applyLineResets?.(layout.screenLines) ?? layout.screenLines;
  const appliedLayout: SplitLayout = {
    ...layout,
    screenLines: normalizeVisibleLines(appliedLines, width),
  };

  renderBoundedViewport(
    tui,
    appliedLayout,
    cursorPos,
    width,
    height,
    shouldClearViewport(tui, width, height, appliedLayout.screenLines),
  );
}

export function configureStickySplitFooterRenderer(nextOptions: StickySplitFooterRendererOptions): void {
  const viewportStatusListenerChanged = options.onViewportStatusChange !== nextOptions.onViewportStatusChange;

  options = {
    enabled: nextOptions.enabled,
    minimumHistoryRows: Math.max(1, Math.floor(nextOptions.minimumHistoryRows)),
    historyViewportLineLimit: Math.max(
      Math.max(1, Math.floor(nextOptions.minimumHistoryRows)),
      Math.floor(nextOptions.historyViewportLineLimit),
    ),
    diagnostic: nextOptions.diagnostic,
    onViewportStatusChange: nextOptions.onViewportStatusChange,
  };

  if (viewportStatusListenerChanged) {
    viewportStatusKeys = new WeakMap<object, string>();
  }
}

function resolveRuntimeTuiPrototype(runtimeTui: TUI | undefined): PatchedTuiPrototype | undefined {
  if (!runtimeTui || typeof runtimeTui !== "object") {
    return undefined;
  }

  const prototype = Object.getPrototypeOf(runtimeTui) as PatchedTuiPrototype | null;
  if (!prototype || typeof prototype !== "object") {
    return undefined;
  }

  return prototype;
}

export function applyStickySplitFooterRendererPatch(
  nextOptions: StickySplitFooterRendererOptions,
  runtimeTui?: TUI,
): StickySplitFooterPatchStatus {
  configureStickySplitFooterRenderer(nextOptions);

  const prototype = resolveRuntimeTuiPrototype(runtimeTui);
  if (!prototype) {
    lastPatchReason = "awaiting-runtime-tui-instance";
    return { installed: patchInstalled, active: patchInstalled && options.enabled, reason: lastPatchReason };
  }

  if (prototype.__piStickyInputPatched) {
    if (typeof prototype.__piStickyInputOriginalDoRender !== "function") {
      patchInstalled = false;
      lastPatchReason = "missing-original-doRender";
      return { installed: false, active: false, reason: lastPatchReason };
    }

    prototype.doRender = patchedDoRender;
    patchInstalled = true;
    lastPatchReason = "already-installed";
    return { installed: true, active: options.enabled, reason: lastPatchReason };
  }

  if (typeof prototype.doRender !== "function") {
    patchInstalled = false;
    lastPatchReason = "missing-runtime-TUI.prototype.doRender";
    return { installed: false, active: false, reason: lastPatchReason };
  }

  prototype.__piStickyInputOriginalDoRender = prototype.doRender;
  prototype.doRender = patchedDoRender;
  prototype.__piStickyInputPatched = true;
  patchInstalled = true;
  lastPatchReason = "installed";

  return { installed: true, active: options.enabled, reason: lastPatchReason };
}

function getCurrentViewportTop(
  tui: object,
  historyLineCount: number,
  historyRows: number,
): { currentViewportTop: number; minimumViewportTop: number; maximumViewportTop: number } {
  const { minimumViewportTop, maximumViewportTop } = getRetainedHistoryBounds(historyLineCount, historyRows);
  const currentState = historyViewportState.get(tui);
  const currentViewportTop = currentState?.followBottom === false
    ? currentState.viewportTop
    : maximumViewportTop;

  return { currentViewportTop, minimumViewportTop, maximumViewportTop };
}

function updateViewportTop(
  runtimeTui: TUI,
  tui: object,
  currentViewportTop: number,
  viewportTop: number,
  minimumViewportTop: number,
  maximumViewportTop: number,
  historyRows: number,
  historyLineCount: number,
): StickySplitFooterScrollResult {
  const currentState = historyViewportState.get(tui);
  const followBottom = viewportTop >= maximumViewportTop;
  const changed = viewportTop !== currentViewportTop || currentState?.followBottom !== followBottom;

  historyViewportState.set(tui, { viewportTop, followBottom });
  notifyViewportStatus(tui, {
    active: true,
    atBottom: followBottom,
    followBottom,
    viewportTop,
    minimumViewportTop,
    maximumViewportTop,
    historyRows,
    historyLineCount,
  });

  if (changed) {
    runtimeTui.requestRender();
  }

  return { handled: true, changed, viewportTop, followBottom };
}

export function scrollStickySplitFooterViewport(
  runtimeTui: TUI | undefined,
  deltaRows: number,
): StickySplitFooterScrollResult {
  if (!runtimeTui || !Number.isFinite(deltaRows) || deltaRows === 0) {
    return { handled: false, changed: false };
  }

  const tui = runtimeTui as unknown as object;
  const metadata = viewportMetadata.get(tui);
  if (!metadata) {
    return { handled: false, changed: false };
  }

  const { currentViewportTop, minimumViewportTop, maximumViewportTop } = getCurrentViewportTop(
    tui,
    metadata.footerStartLine,
    metadata.historyRows,
  );
  const viewportTop = clamp(currentViewportTop + Math.trunc(deltaRows), minimumViewportTop, maximumViewportTop);

  return updateViewportTop(
    runtimeTui,
    tui,
    currentViewportTop,
    viewportTop,
    minimumViewportTop,
    maximumViewportTop,
    metadata.historyRows,
    metadata.footerStartLine,
  );
}

export function resetStickySplitFooterViewport(runtimeTui?: TUI): void {
  if (!runtimeTui) {
    return;
  }

  const tui = runtimeTui as unknown as object;
  notifyViewportStatus(tui, undefined);
  historyViewportState.delete(tui);
  viewportMetadata.delete(tui);
}

export function getStickySplitFooterPatchStatus(): StickySplitFooterPatchStatus {
  return {
    installed: patchInstalled,
    active: patchInstalled && options.enabled,
    reason: lastPatchReason,
  };
}
