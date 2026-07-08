const assert = require("node:assert/strict");
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const jiti = createJiti(path.join(__dirname, "debug-logger.test.cjs"), { interopDefault: true });
const { DebugLogger } = jiti("../src/logging/debug-logger.ts");

async function withTempRoot(run) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-claude-style-scroll-debug-"));
  try {
    await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("disabled debug logger is a no-op and does not create debug artifacts", async () => {
  await withTempRoot(async (root) => {
    const logger = DebugLogger.create({ debug: false }, { extensionRoot: root });

    assert.equal(logger.log("disabled", { token: "secret" }), undefined);
    await logger.flush();

    assert.equal(existsSync(path.join(root, "debug")), false);
  });
});

test("enabled debug logger writes on flush and redacts secret fields", async () => {
  await withTempRoot(async (root) => {
    const logger = DebugLogger.create({ debug: true }, { extensionRoot: root });

    assert.equal(logger.log("render", {
      apiKey: "secret-key",
      nested: { authorization: "Bearer secret-token", safe: "visible" },
    }), undefined);
    assert.equal(existsSync(path.join(root, "debug")), false, "write should be scheduled asynchronously");
    await logger.flush();

    const logContent = readFileSync(path.join(root, "debug", "debug.log"), "utf-8");
    assert.match(logContent, /"extension":"pi-claude-style-scroll"/);
    assert.match(logContent, /"event":"render"/);
    assert.match(logContent, /"apiKey":"\[REDACTED\]"/);
    assert.match(logContent, /"authorization":"\[REDACTED\]"/);
    assert.match(logContent, /"safe":"visible"/);
    assert.doesNotMatch(logContent, /secret-key|secret-token/);
  });
});

test("debug logger swallows filesystem failures", async () => {
  await withTempRoot(async (root) => {
    writeFileSync(path.join(root, "debug"), "not a directory", "utf-8");
    const logger = DebugLogger.create({ debug: true }, { extensionRoot: root });

    assert.doesNotThrow(() => logger.log("write-fails", { password: "secret" }));
    await assert.doesNotReject(() => logger.flush());
  });
});
