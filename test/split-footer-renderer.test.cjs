const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(path.join(__dirname, "split-footer-renderer.test.cjs"), { interopDefault: true });
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

class Container {
  constructor(children) {
    this.children = children;
  }

  render(width) {
    return this.children.flatMap((child) => child.render(width));
  }

  invalidate() {}
}

function createRuntimeTui() {
  class RuntimeTui {
    constructor() {
      this.history = Array.from({ length: 20 }, (_unused, index) => `history-${index}`);
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
        rows: 10,
        writes: [],
        write(data) {
          this.writes.push(data);
        },
      };
      this.renderRequests = 0;
    }

    doRender() {
      throw new Error("original renderer should not run in supported sticky layout");
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

function createRuntimeTuiWithOriginalRenderer() {
  class RuntimeTui {
    constructor() {
      this.history = Array.from({ length: 20 }, (_unused, index) => `history-${index}`);
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
      this.originalPreviousLineCounts = [];
      this.terminal = {
        columns: 80,
        rows: 10,
        writes: [],
        write(data) {
          this.writes.push(data);
        },
      };
      this.renderRequests = 0;
    }

    doRender() {
      this.originalPreviousLineCounts.push(this.previousLines.length);
      this.previousLines = [`original-render-${this.originalPreviousLineCounts.length}`];
      this.previousWidth = this.terminal.columns;
      this.previousHeight = this.terminal.rows;
    }

    hasOverlay() {
      return this.overlayStack.length > 0;
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

function patchRuntimeTui(tui) {
  const status = renderer.applyStickySplitFooterRendererPatch(
    {
      enabled: true,
      minimumHistoryRows: 3,
      historyViewportLineLimit: 200,
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

test("typing in the sticky editor only rewrites changed viewport rows after the first render", () => {
  const tui = createRuntimeTui();
  const doRender = patchRuntimeTui(tui);

  doRender.call(tui);
  tui.terminal.writes = [];

  tui.sticky[2].lines = ["editor changed while typing"];
  doRender.call(tui);

  const buffer = tui.terminal.writes.join("");
  assert.deepEqual(countAbsoluteRowMoves(buffer), [8]);
  assert.equal(buffer.includes("\x1b[2K"), false, "incremental typing should not blank the row before rewriting");
  assert.equal(buffer.includes("history-15"), false, "unchanged history rows should not be redrawn while typing");
});

test("incremental full-width rows do not clear their final cell", () => {
  const tui = createRuntimeTui();
  const doRender = patchRuntimeTui(tui);
  const fullWidthEditorLine = "E".repeat(tui.terminal.columns);

  doRender.call(tui);
  tui.terminal.writes = [];

  tui.sticky[2].lines = [fullWidthEditorLine];
  doRender.call(tui);

  const buffer = tui.terminal.writes.join("");
  assert.equal(buffer.includes(fullWidthEditorLine), true);
  assert.equal(
    buffer.includes(`${fullWidthEditorLine}\x1b[K`),
    false,
    "clearing to end-of-line after a full-width row erases the rightmost cell in some terminals",
  );
});

test("long Sixel protocol rows remain complete through sticky renderer updates", () => {
  const tui = createRuntimeTui();
  const doRender = patchRuntimeTui(tui);
  const longSixelRow = `\x1b_Gm=0;\x1b\\\x1bPq${"A".repeat(tui.terminal.columns * 3)}\x1b\\`;

  doRender.call(tui);
  tui.terminal.writes = [];

  tui.history[tui.history.length - 1] = longSixelRow;
  doRender.call(tui);

  const buffer = tui.terminal.writes.join("");
  assert.equal(tui.previousLines[4], longSixelRow, "renderer state should retain the complete protocol row");
  assert.equal(buffer.includes(longSixelRow), true, "terminal write should include the complete protocol row");
  assert.equal(
    buffer.includes(`${longSixelRow}\x1b[K`),
    false,
    "clear-to-EOL after an image protocol row can corrupt terminal graphics parsing",
  );
});

test("reduced history keeps multi-row image spans whole when new lines arrive below them", () => {
  const tui = createRuntimeTui();
  tui.terminal.rows = 8;
  const doRender = patchRuntimeTui(tui);
  const multiRowImageSpan = [
    "",
    "",
    "\x1b_Gm=0;\x1b\\\x1b[2A\x1bPqIMAGE\x1b\\",
  ];

  tui.history = [
    "history-0",
    "history-1",
    "history-2",
    "history-3",
    "history-4",
    ...multiRowImageSpan,
  ];
  tui.children = [new Child(tui.history), ...tui.sticky];

  doRender.call(tui);
  assert.deepEqual(
    tui.previousLines.slice(0, 3),
    multiRowImageSpan,
    "initial reduced viewport should show the whole image span",
  );

  tui.terminal.writes = [];
  tui.history.push("after-image");
  doRender.call(tui);

  assert.deepEqual(
    tui.previousLines.slice(0, 3),
    multiRowImageSpan,
    "follow-bottom viewport should stay anchored to the whole image span",
  );
  assert.equal(
    tui.terminal.writes.length,
    0,
    "hidden lines below an anchored image span should not trigger a partial redraw",
  );
});

test("scrolling an inline image span to a new screen row forces a full clear redraw", () => {
  const tui = createRuntimeTui();
  const doRender = patchRuntimeTui(tui);
  const multiRowImageSpan = [
    "",
    "",
    "\x1b_Gm=0;\x1b\\\x1b[2A\x1bPqIMAGE\x1b\\",
  ];

  tui.history = [
    "history-0",
    "history-1",
    "history-2",
    ...multiRowImageSpan,
    "history-6",
  ];
  tui.children = [new Child(tui.history), ...tui.sticky];

  doRender.call(tui);
  tui.terminal.writes = [];

  const scrollResult = renderer.scrollStickySplitFooterViewport(tui, -1);
  assert.equal(scrollResult.handled, true);
  assert.equal(scrollResult.changed, true);

  doRender.call(tui);

  const buffer = tui.terminal.writes.join("");
  assert.equal(
    buffer.includes("\x1b[r\x1b[H\x1b[2J"),
    true,
    "moved image spans should reuse the full clear redraw path",
  );
  assert.deepEqual(countAbsoluteRowMoves(buffer), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(tui.fullRedrawCount, 2);
});

test("jumping home to a same-geometry inline image replacement forces a full clear redraw", () => {
  const tui = createRuntimeTui();
  const doRender = patchRuntimeTui(tui);
  const topImageSpan = [
    "",
    "",
    "\x1b_Gm=0;\x1b\\\x1b[2A\x1bPqTOP_IMAGE\x1b\\",
  ];
  const bottomImageSpan = [
    "",
    "",
    "\x1b_Gm=0;\x1b\\\x1b[2A\x1bPqBOTTOM_IMAGE\x1b\\",
  ];

  tui.history = [
    "history-0",
    "history-1",
    ...topImageSpan,
    "history-5",
    "history-6",
    "history-7",
    "history-8",
    "history-9",
    ...bottomImageSpan,
  ];
  tui.children = [new Child(tui.history), ...tui.sticky];

  doRender.call(tui);
  assert.deepEqual(tui.previousLines.slice(0, 5), ["history-8", "history-9", ...bottomImageSpan]);
  tui.terminal.writes = [];

  const homeResult = renderer.scrollStickySplitFooterViewport(tui, -Number.MAX_SAFE_INTEGER);
  assert.equal(homeResult.handled, true);
  assert.equal(homeResult.changed, true);
  assert.equal(homeResult.viewportTop, 0);

  doRender.call(tui);

  const buffer = tui.terminal.writes.join("");
  assert.deepEqual(tui.previousLines.slice(0, 5), ["history-0", "history-1", ...topImageSpan]);
  assert.equal(
    buffer.includes("\x1b[r\x1b[H\x1b[2J"),
    true,
    "same-geometry image replacements should reuse the full clear redraw path",
  );
  assert.deepEqual(countAbsoluteRowMoves(buffer), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(tui.fullRedrawCount, 2);
});

test("native inline image rows with leading cursor-up prefixes keep their multi-row span anchored", () => {
  const tui = createRuntimeTui();
  tui.terminal.rows = 8;
  const doRender = patchRuntimeTui(tui);
  const nativeImageSpan = [
    "",
    "",
    "\x1b[2A\x1b]1337;File=name=preview.png:inline=1:DATA\x07",
  ];

  tui.history = [
    "history-0",
    "history-1",
    "history-2",
    "history-3",
    "history-4",
    ...nativeImageSpan,
  ];
  tui.children = [new Child(tui.history), ...tui.sticky];

  doRender.call(tui);
  assert.deepEqual(
    tui.previousLines.slice(0, 3),
    nativeImageSpan,
    "initial reduced viewport should show the whole native image span",
  );

  tui.terminal.writes = [];
  tui.history.push("after-image");
  doRender.call(tui);

  assert.deepEqual(
    tui.previousLines.slice(0, 3),
    nativeImageSpan,
    "follow-bottom viewport should stay anchored to the whole native image span",
  );
  assert.equal(
    tui.terminal.writes.length,
    0,
    "hidden lines below a native anchored image span should not trigger a partial redraw",
  );
});

test("history viewport remains pinned when new history arrives while scrolled up", () => {
  const tui = createRuntimeTui();
  const doRender = patchRuntimeTui(tui);

  doRender.call(tui);
  const initial = tui.previousLines.slice(0, 5);
  assert.deepEqual(initial, ["history-15", "history-16", "history-17", "history-18", "history-19"]);

  const scrollResult = renderer.scrollStickySplitFooterViewport(tui, -4);
  assert.equal(scrollResult.handled, true);
  assert.equal(scrollResult.followBottom, false);

  doRender.call(tui);
  const scrolled = tui.previousLines.slice(0, 5);
  assert.deepEqual(scrolled, ["history-11", "history-12", "history-13", "history-14", "history-15"]);

  tui.history.push("history-20", "history-21");
  doRender.call(tui);
  assert.deepEqual(tui.previousLines.slice(0, 5), scrolled);
});

test("expanded long tool output can scroll above the retained history line limit", () => {
  const tui = createRuntimeTui();
  tui.history = Array.from({ length: 300 }, (_unused, index) => `expanded-output-${index}`);
  tui.children = [new Child(tui.history), ...tui.sticky];
  const doRender = patchRuntimeTui(tui);

  doRender.call(tui);
  assert.deepEqual(tui.previousLines.slice(0, 5), [
    "expanded-output-295",
    "expanded-output-296",
    "expanded-output-297",
    "expanded-output-298",
    "expanded-output-299",
  ]);

  const topResult = renderer.scrollStickySplitFooterViewport(tui, -Number.MAX_SAFE_INTEGER);
  assert.equal(topResult.handled, true);
  assert.equal(topResult.changed, true);
  assert.equal(topResult.viewportTop, 0);

  doRender.call(tui);
  assert.deepEqual(tui.previousLines.slice(0, 5), [
    "expanded-output-0",
    "expanded-output-1",
    "expanded-output-2",
    "expanded-output-3",
    "expanded-output-4",
  ]);
});

test("visible overlays hand off to the original renderer without repeated state resets", () => {
  const tui = createRuntimeTuiWithOriginalRenderer();
  const doRender = patchRuntimeTui(tui);

  doRender.call(tui);
  assert.equal(tui.previousLines.length, 10);

  tui.overlayStack.push({});
  doRender.call(tui);
  doRender.call(tui);

  assert.deepEqual(tui.originalPreviousLineCounts, [0, 1]);
});
