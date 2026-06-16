const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(path.join(__dirname, "split-footer-renderer-edge-red.test.cjs"), { interopDefault: true });
const renderer = jiti("../src/tui/split-footer-renderer.ts");

class Child {
  constructor(lines) {
    this.lines = lines;
  }

  render() {
    return this.lines;
  }

  invalidate() {}
}

function createRuntimeTui({ historyLineCount = 20, rows = 10 } = {}) {
  class RuntimeTui {
    constructor() {
      this.history = Array.from({ length: historyLineCount }, (_unused, index) => `history-${index}`);
      this.sticky = [
        new Child(["status"]),
        new Child(["widget-above"]),
        new Child(["editor"]),
        new Child(["widget-below"]),
        new Child(["footer"]),
      ];
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
      this.terminal = {
        columns: 80,
        rows,
        writes: [],
        write(data) {
          this.writes.push(data);
        },
      };
      this.renderRequests = 0;
      this.originalRenderCount = 0;
    }

    doRender() {
      this.originalRenderCount += 1;
      this.previousLines = [`original-render-${this.originalRenderCount}`];
      this.previousWidth = this.terminal.columns;
      this.previousHeight = this.terminal.rows;
    }

    hasOverlay() {
      return false;
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

  return new RuntimeTui();
}

function patchRuntimeTui(tui, options = {}) {
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

test("ASSUMED: retained history respects configured historyViewportLineLimit while preserving bottom-follow", () => {
  const tui = createRuntimeTui({ historyLineCount: 300 });
  const doRender = patchRuntimeTui(tui, { historyViewportLineLimit: 20 });

  doRender.call(tui);
  assert.deepEqual(tui.previousLines.slice(0, 5), [
    "history-295",
    "history-296",
    "history-297",
    "history-298",
    "history-299",
  ]);

  const topResult = renderer.scrollStickySplitFooterViewport(tui, -Number.MAX_SAFE_INTEGER);
  assert.equal(topResult.handled, true);
  assert.equal(topResult.changed, true);
  assert.equal(topResult.viewportTop, 275);

  doRender.call(tui);
  assert.deepEqual(tui.previousLines.slice(0, 5), [
    "history-275",
    "history-276",
    "history-277",
    "history-278",
    "history-279",
  ]);
});

test("oversized inline image fallback clears sticky renderer state before original renderer handoff", () => {
  const diagnostics = [];
  const tui = createRuntimeTui({ rows: 8 });
  const doRender = patchRuntimeTui(tui, { diagnostic: (event, fields) => diagnostics.push({ event, fields }) });

  doRender.call(tui);
  assert.equal(tui.previousLines.length, 8);

  tui.history = [
    "history-before",
    "",
    "",
    "",
    "\x1b_Gm=0;\x1b\\\x1b[3A\x1bPqIMAGE_SPAN_TOO_TALL\x1b\\",
  ];
  tui.children = [new Child(tui.history), ...tui.sticky];

  doRender.call(tui);

  assert.equal(tui.originalRenderCount, 1);
  assert.deepEqual(tui.previousLines, ["original-render-1"]);
  assert.equal(diagnostics.at(-1)?.event, "fallback");
  assert.equal(diagnostics.at(-1)?.fields.reason, "history-inline-image-span-too-tall");
  assert.equal(diagnostics.at(-1)?.fields.leavingStickyRenderer, true);
});
