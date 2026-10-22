const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");
const { createRuntimeTui } = require("./helpers/split-footer-fixtures.cjs");

const jiti = createJiti(__filename, { interopDefault: true });
const renderer = jiti("../src/tui/split-footer-renderer.ts");
const { default: stickyInputExtension } = jiti("../src/index.ts");
const options = { enabled: true, minimumHistoryRows: 3, historyViewportLineLimit: 200 };

test("fullscreen renderers remain untouched even when legacy internals are present", () => {
  let originalRenderCount = 0;
  const tui = createRuntimeTui({
    extraState: { mode: "fullscreen" },
    doRender: () => { originalRenderCount += 1; },
  });
  const prototype = Object.getPrototypeOf(tui);
  const originalDoRender = prototype.doRender;

  assert.deepEqual(renderer.applyStickySplitFooterRendererPatch(options, tui), {
    installed: false,
    active: false,
    reason: "native-fullscreen-scrolling",
  });
  assert.equal(prototype.doRender, originalDoRender);
  assert.equal(prototype.__piStickyInputPatched, undefined);
  assert.deepEqual(tui.terminal.writes, []);
  tui.doRender();
  assert.equal(originalRenderCount, 1);
});

test("renderers without previousLines are rejected before patching", () => {
  const tui = createRuntimeTui();
  delete tui.previousLines;
  const originalDoRender = Object.getPrototypeOf(tui).doRender;

  assert.deepEqual(renderer.applyStickySplitFooterRendererPatch(options, tui), {
    installed: false,
    active: false,
    reason: "missing-required-tui-internals",
  });
  assert.equal(Object.getPrototypeOf(tui).doRender, originalDoRender);
  assert.deepEqual(tui.terminal.writes, []);
});

test("fallback diagnostics tolerate previousLines disappearing after installation", () => {
  let originalRenderCount = 0;
  const diagnostics = [];
  const tui = createRuntimeTui({ doRender: () => { originalRenderCount += 1; } });
  assert.equal(renderer.applyStickySplitFooterRendererPatch({
    ...options,
    diagnostic: (event, fields) => diagnostics.push({ event, fields }),
  }, tui).active, true);
  delete tui.previousLines;

  assert.doesNotThrow(() => tui.doRender());
  assert.equal(originalRenderCount, 1);
  assert.equal(diagnostics.at(-1).event, "fallback");
  assert.equal(diagnostics.at(-1).fields.reason, "missing-required-tui-internals");
  assert.equal(diagnostics.at(-1).fields.previousScreenRows, undefined);
});

test("fullscreen startup, input, commands, reload and session replacement preserve native handling", async () => {
  const handlers = new Map();
  const commands = new Map();
  stickyInputExtension({
    on: (name, handler) => handlers.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
  });
  const tui = createRuntimeTui({ extraState: { mode: "fullscreen" } });
  const originalDoRender = Object.getPrototypeOf(tui).doRender;
  tui.stop = () => {};
  const originalStop = tui.stop;
  const notices = [];
  let listener;
  let editorText = "";
  const ctx = {
    cwd: path.join(__dirname, ".."),
    hasUI: true,
    ui: {
      setStatus: () => {},
      notify: (message) => notices.push(message),
      getEditorText: () => editorText,
      setWidget: (_key, factory) => {
        if (typeof factory === "function") factory(tui);
      },
      onTerminalInput: (handler) => {
        listener = handler;
        return () => { listener = undefined; };
      },
    },
  };

  for (const reason of ["switch", "quit"]) {
    await handlers.get("session_start")({}, ctx);
    for (const text of ["", "unfinished prompt"]) {
      editorText = text;
      for (const data of ["\x1b[A", "\x1b[B", "\x1b[<64;10;10M", "\x1b[<65;10;10M", "\x1b[5~"]) {
        assert.equal(listener(data), undefined);
      }
    }
    for (const arg of ["status", "on", "off", "toggle"]) {
      await commands.get("claude-style-scroll").handler(arg, ctx);
      assert.match(notices.at(-1), /Pi's fullscreen mode/);
    }
    await handlers.get("resources_discover")({ reason: "reload" }, ctx);
    assert.equal(listener("\x1b[A"), undefined);
    assert.equal(Object.getPrototypeOf(tui).doRender, originalDoRender);
    assert.equal(tui.stop, originalStop);
    assert.deepEqual(tui.terminal.writes, []);
    await handlers.get("session_shutdown")({ reason }, ctx);
    assert.equal(listener, undefined);
    assert.deepEqual(tui.terminal.writes, []);
  }
});
