const assert = require("node:assert/strict");

/**
 * Shared test fixtures for split-footer-renderer tests.
 *
 * Consolidates the `Child`/`Container` component doubles, the `RuntimeTui`
 * harness, and the `patchRuntimeTui`/`countAbsoluteRowMoves` helpers that were
 * duplicated across split-footer-renderer.test.cjs and
 * split-footer-renderer-edge-red.test.cjs.
 */

class Child {
  constructor(lines) {
    this.lines = lines;
  }

  render() {
    return this.lines;
  }

  invalidate() {}
}

class Container {
  constructor(children) {
    this.children = children;
  }

  render(width) {
    return this.children.flatMap((child) => child.render(width));
  }

  invalidate() {}
}

const DEFAULT_STICKY_CHILDREN = () => [
  new Child(["status"]),
  new Child(["widget-above"]),
  new Child(["editor"]),
  new Child(["widget-below"]),
  new Child(["footer"]),
];

/**
 * Build a RuntimeTui instance sharing the common constructor state and
 * prototype methods (extractCursorPosition, applyLineResets, etc.) across all
 * renderer test fixtures. `doRender` and `hasOverlay` hooks let callers
 * customize behavior without re-declaring the entire class.
 *
 * The class-based form is required because `applyStickySplitFooterRendererPatch`
 * patches `Object.getPrototypeOf(tui).doRender`, so `doRender` must live on the
 * prototype, not the instance.
 */
function createRuntimeTui({
  historyLineCount = 20,
  rows = 10,
  doRender = () => {
    throw new Error("original renderer should not run in supported sticky layout");
  },
  hasOverlay = () => false,
  extraState = {},
} = {}) {
  class RuntimeTui {
    constructor() {
      this.history = Array.from({ length: historyLineCount }, (_unused, index) => `history-${index}`);
      this.sticky = DEFAULT_STICKY_CHILDREN();
      this.children = [new Child(this.history), ...this.sticky];
      this.previousLines = [];
      this.previousWidth = 0;
      this.previousHeight = 0;
      this.cursorRow = 0;
      this.hardwareCursorRow = 0;
      this.clearOnShrink = false;
      this.maxLinesRendered = 0;
      this.previousViewportTop = 0;
      this.fullRedrawCount = 0;
      this.stopped = false;
      this.overlayStack = [];
      this.renderRequests = 0;
      this.terminal = {
        columns: 80,
        rows,
        writes: [],
        write(data) {
          this.writes.push(data);
        },
      };
      Object.assign(this, extraState);
    }

    extractCursorPosition() {
      return null;
    }

    applyLineResets(lines) {
      return lines;
    }

    positionHardwareCursor() {}

    requestRender() {
      this.renderRequests += 1;
    }
  }

  RuntimeTui.prototype.doRender = doRender;
  RuntimeTui.prototype.hasOverlay = hasOverlay;
  return new RuntimeTui();
}

function patchRuntimeTui(renderer, tui, options = {}) {
  const status = renderer.applyStickySplitFooterRendererPatch(
    {
      enabled: true,
      minimumHistoryRows: 3,
      historyViewportLineLimit: 200,
      ...options,
    },
    tui,
  );
  assert.equal(status.installed, true);
  assert.equal(status.active, true);
  return Object.getPrototypeOf(tui).doRender;
}

function countAbsoluteRowMoves(buffer) {
  return Array.from(buffer.matchAll(/\x1b\[(\d+);1H/g)).map((match) => Number(match[1]));
}

/** Rebuild `tui.children` from the current `tui.history` and `tui.sticky` arrays. */
function rebuildChildren(tui) {
  tui.children = [new Child(tui.history), ...tui.sticky];
}

module.exports = {
  Child,
  Container,
  createRuntimeTui,
  patchRuntimeTui,
  countAbsoluteRowMoves,
  rebuildChildren,
};
