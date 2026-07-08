const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(path.join(__dirname, "mouse-scroll-command.test.cjs"), { interopDefault: true });
const command = jiti("../src/commands/mouse-scroll-command.ts");

test("claude-style-scroll command toggles mouse scroll by default", () => {
  assert.deepEqual(command.parseStickyInputCommandArgs(""), { type: "toggle" });
  assert.deepEqual(command.parseStickyInputCommandArgs("mouse"), { type: "toggle" });
  assert.deepEqual(command.parseStickyInputCommandArgs("toggle"), { type: "toggle" });
});

test("claude-style-scroll command supports explicit mouse scroll modes", () => {
  assert.deepEqual(command.parseStickyInputCommandArgs("on"), { type: "setMouseScroll", enabled: true });
  assert.deepEqual(command.parseStickyInputCommandArgs("mouse enable"), { type: "setMouseScroll", enabled: true });
  assert.deepEqual(command.parseStickyInputCommandArgs("off"), { type: "setMouseScroll", enabled: false });
  assert.deepEqual(command.parseStickyInputCommandArgs("mouse native"), { type: "setMouseScroll", enabled: false });
});

test("claude-style-scroll command reports status and invalid arguments", () => {
  assert.deepEqual(command.parseStickyInputCommandArgs("status"), { type: "status" });
  assert.deepEqual(command.parseStickyInputCommandArgs("mouse status"), { type: "status" });
  assert.equal(command.parseStickyInputCommandArgs("mouse maybe").type, "error");
});

test("claude-style-scroll mouse scroll mode always disables alternate-scroll arrow translation", () => {
  const config = { mouseScroll: false, alternateScroll: true };

  command.applyStickyMouseScrollMode(config, true);
  assert.equal(config.mouseScroll, true);
  assert.equal(config.alternateScroll, false);

  command.applyStickyMouseScrollMode(config, false);
  assert.equal(config.mouseScroll, false);
  assert.equal(config.alternateScroll, false);
});
