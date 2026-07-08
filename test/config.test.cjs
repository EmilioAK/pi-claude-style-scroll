const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { createJiti } = require("jiti");
const fs = require("node:fs");
const os = require("node:os");

function loadConfigModule(virtualPiCodingAgent) {
  const jiti = createJiti(path.join(__dirname, `config-${Date.now()}-${Math.random()}.test.cjs`), {
    fsCache: false,
    interopDefault: true,
    moduleCache: false,
    virtualModules: virtualPiCodingAgent
      ? { "@earendil-works/pi-coding-agent": virtualPiCodingAgent }
      : undefined,
  });

  return jiti("../src/config/config.ts");
}

test("project config path uses the public CONFIG_DIR_NAME export", () => {
  const config = loadConfigModule({
    CONFIG_DIR_NAME: ".custom-pi-test",
    getAgentDir: () => path.join("agent", "dir"),
  });

  assert.equal(
    config.getProjectConfigPath(path.join("workspace", "project")),
    path.join(path.resolve("workspace", "project"), ".custom-pi-test", "extensions", "pi-claude-style-scroll", "config.json"),
  );
});

test("project config path keeps the default .pi directory with the bundled agent config", () => {
  const config = loadConfigModule();

  assert.equal(
    config.getProjectConfigPath(path.join("workspace", "project")),
    path.join(path.resolve("workspace", "project"), ".pi", "extensions", "pi-claude-style-scroll", "config.json"),
  );
});

// ---------------------------------------------------------------------------
// Project-config coverage (TDD).
// These tests exercise the PUBLIC config API (getProjectConfigPath,
// getGlobalConfigPath, getConfigPaths, loadStickyInputConfig) and assert only
// user-visible behavior: resolved paths, layered config values, and warnings.
// They cover path resolution, global+project layering, missing project config,
// invalid project config, and validation/default preservation.
// ---------------------------------------------------------------------------

let realConfigModule;
function realModule() {
  // Cache the real module (default CONFIG_DIR_NAME=".pi", real getAgentDir).
  // config.ts has no mutable module state, so reuse is safe and isolated.
  if (!realConfigModule) {
    realConfigModule = loadConfigModule();
  }
  return realConfigModule;
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-style-scroll-config-"));
}

function removeDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeConfigFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content), "utf-8");
}

/** Create a temp config file, run `fn(file)`, and clean up. */
function withConfigFile(name, content, fn) {
  const file = path.join(makeTempDir(), name);
  try {
    writeConfigFile(file, content);
    return fn(file);
  } finally {
    removeDir(path.dirname(file));
  }
}

/** Create a temp directory, run `fn(dir)`, and clean up. */
function withTempDir(fn) {
  const dir = makeTempDir();
  try {
    return fn(dir);
  } finally {
    removeDir(dir);
  }
}

/** Assert getConfigPaths returned bundled + legacy global + global paths (no project path). */
function assertBundledAndGlobalPaths(mod, paths, agentDir) {
  assert.equal(paths.length, 3);
  assert.equal(paths[0], mod.getConfigPath());
  assert.equal(paths[1], mod.getLegacyGlobalConfigPath(agentDir));
  assert.equal(paths[2], mod.getGlobalConfigPath(agentDir));
}

// --- Path resolution ---

test("getGlobalConfigPath resolves under the agent dir extensions area", () => {
  const mod = realModule();
  assert.equal(
    mod.getGlobalConfigPath(path.join("agent", "root")),
    path.join(path.resolve("agent", "root"), "extensions", "pi-claude-style-scroll", "config.json"),
  );
});

test("getGlobalConfigPath default agent dir ends with the extensions config path", () => {
  const mod = realModule();
  const result = mod.getGlobalConfigPath();
  assert.ok(
    result.endsWith(path.join("extensions", "pi-claude-style-scroll", "config.json")),
    `unexpected global config path: ${result}`,
  );
});

test("getConfigPaths returns bundled, global, project in layering order", () => {
  const mod = realModule();
  withTempDir((cwd) => {
    withTempDir((agentDir) => {
      const paths = mod.getConfigPaths({ cwd, agentDir });
      assert.equal(paths.length, 5);
      assert.equal(paths[0], mod.getConfigPath());
      assert.equal(paths[1], mod.getLegacyGlobalConfigPath(agentDir));
      assert.equal(paths[2], mod.getGlobalConfigPath(agentDir));
      assert.equal(paths[3], mod.getLegacyProjectConfigPath(cwd));
      assert.equal(paths[4], mod.getProjectConfigPath(cwd));
    });
  });
});

test("getConfigPaths omits the project path when cwd is not provided", () => {
  const mod = realModule();
  withTempDir((agentDir) => {
    assertBundledAndGlobalPaths(mod, mod.getConfigPaths({ agentDir }), agentDir);
  });
});

test("getConfigPaths de-duplicates coincident global and project paths", () => {
  const mod = realModule();
  withTempDir((cwd) => {
    // Agent dir placed at the project's .pi dir => global path == project path.
    const agentDir = path.join(cwd, ".pi");
    assertBundledAndGlobalPaths(mod, mod.getConfigPaths({ cwd, agentDir }), agentDir);
  });
});

// --- Global + project layering ---

test("project config layers over global config, preserving unset fields", () => {
  const mod = realModule();
  withConfigFile("global.json", { enabled: false, mouseWheelScrollRows: 7 }, (globalFile) => {
    withConfigFile("project.json", { debug: true }, (projectFile) => {
      const result = mod.loadStickyInputConfig({ paths: [globalFile, projectFile] });
      assert.equal(result.config.enabled, false);          // from global
      assert.equal(result.config.mouseWheelScrollRows, 7); // from global, preserved by project
      assert.equal(result.config.debug, true);             // from project
      assert.equal(result.config.alternateScreen, true);   // default preserved
      assert.equal(result.warnings.length, 0);
    });
  });
});

test("end-to-end resolution and layering from cwd and agent dir", () => {
  const mod = realModule();
  withTempDir((cwd) => {
    withTempDir((agentDir) => {
      writeConfigFile(mod.getGlobalConfigPath(agentDir), { enabled: false });
      writeConfigFile(mod.getProjectConfigPath(cwd), { debug: true });
      const result = mod.loadStickyInputConfig({ paths: mod.getConfigPaths({ cwd, agentDir }) });
      assert.equal(result.config.enabled, false); // global override, not reset by project
      assert.equal(result.config.debug, true);    // project override
    });
  });
});

// --- Missing project config behavior ---

test("missing config files yield defaults with no warnings", () => {
  const mod = realModule();
  withTempDir((dir) => {
    const missing = path.join(dir, "does-not-exist.json");
    const result = mod.loadStickyInputConfig({ paths: [missing] });
    assert.deepEqual(result.config, mod.DEFAULT_STICKY_INPUT_CONFIG);
    assert.equal(result.warnings.length, 0);
  });
});

test("missing project config is silent and preserves the global layer", () => {
  const mod = realModule();
  withConfigFile("global.json", { enabled: false }, (globalFile) => {
    withTempDir((dir) => {
      const missingProject = path.join(dir, "missing-project.json");
      const result = mod.loadStickyInputConfig({ paths: [globalFile, missingProject] });
      assert.equal(result.config.enabled, false);
      assert.equal(result.warnings.length, 0);
    });
  });
});

// --- Invalid project config behavior ---

test("malformed JSON config warns and falls back to defaults", () => {
  const mod = realModule();
  withConfigFile("bad.json", "{ not valid json", (file) => {
    const result = mod.loadStickyInputConfig({ paths: [file] });
    assert.deepEqual(result.config, mod.DEFAULT_STICKY_INPUT_CONFIG);
    assert.ok(result.warnings.length >= 1);
    assert.ok(result.warnings.some((w) => w.includes(file)), `warnings: ${JSON.stringify(result.warnings)}`);
  });
});

test("non-object config root warns and falls back to defaults", () => {
  const mod = realModule();
  withConfigFile("array-root.json", [1, 2, 3], (file) => {
    const result = mod.loadStickyInputConfig({ paths: [file] });
    assert.deepEqual(result.config, mod.DEFAULT_STICKY_INPUT_CONFIG);
    assert.ok(result.warnings.some((w) => w.includes(file)));
  });
});

test("invalid field type warns and falls back to the default value", () => {
  const mod = realModule();
  withConfigFile("bad-field.json", { enabled: "yes" }, (file) => {
    const result = mod.loadStickyInputConfig({ paths: [file] });
    assert.equal(result.config.enabled, mod.DEFAULT_STICKY_INPUT_CONFIG.enabled);
    assert.ok(result.warnings.some((w) => w.includes(file) && w.includes("enabled")));
  });
});

test("out-of-range integer warns and falls back to the default value", () => {
  const mod = realModule();
  withConfigFile("bad-range.json", { mouseWheelScrollRows: 999 }, (file) => {
    const result = mod.loadStickyInputConfig({ paths: [file] });
    assert.equal(result.config.mouseWheelScrollRows, mod.DEFAULT_STICKY_INPUT_CONFIG.mouseWheelScrollRows);
    assert.ok(result.warnings.some((w) => w.includes(file) && w.includes("mouseWheelScrollRows")));
  });
});

// --- Config validation / default preservation ---

test("empty config object preserves all defaults with no warnings", () => {
  const mod = realModule();
  withConfigFile("empty.json", {}, (file) => {
    const result = mod.loadStickyInputConfig({ paths: [file] });
    assert.deepEqual(result.config, mod.DEFAULT_STICKY_INPUT_CONFIG);
    assert.equal(result.warnings.length, 0);
  });
});

test("partial valid config applies set fields and preserves defaults", () => {
  const mod = realModule();
  withConfigFile("partial.json", { enabled: false, keyboardScrollRows: 25 }, (file) => {
    const result = mod.loadStickyInputConfig({ paths: [file] });
    assert.equal(result.config.enabled, false);
    assert.equal(result.config.keyboardScrollRows, 25);
    assert.equal(result.config.debug, mod.DEFAULT_STICKY_INPUT_CONFIG.debug);
    assert.equal(result.config.alternateScreen, mod.DEFAULT_STICKY_INPUT_CONFIG.alternateScreen);
    assert.equal(result.warnings.length, 0);
  });
});

test("boundary integer values at min and max are accepted", () => {
  const mod = realModule();
  withConfigFile("min.json", { mouseWheelScrollRows: 1 }, (minFile) => {
    withConfigFile("max.json", { mouseWheelScrollRows: 50 }, (maxFile) => {
      const minResult = mod.loadStickyInputConfig({ paths: [minFile] });
      const maxResult = mod.loadStickyInputConfig({ paths: [maxFile] });
      assert.equal(minResult.config.mouseWheelScrollRows, 1);
      assert.equal(maxResult.config.mouseWheelScrollRows, 50);
      assert.equal(minResult.warnings.length, 0);
      assert.equal(maxResult.warnings.length, 0);
    });
  });
});

test("boundary integer values below min and above max are rejected", () => {
  const mod = realModule();
  withConfigFile("below.json", { mouseWheelScrollRows: 0 }, (belowFile) => {
    withConfigFile("above.json", { mouseWheelScrollRows: 51 }, (aboveFile) => {
      const below = mod.loadStickyInputConfig({ paths: [belowFile] });
      const above = mod.loadStickyInputConfig({ paths: [aboveFile] });
      assert.equal(below.config.mouseWheelScrollRows, mod.DEFAULT_STICKY_INPUT_CONFIG.mouseWheelScrollRows);
      assert.equal(above.config.mouseWheelScrollRows, mod.DEFAULT_STICKY_INPUT_CONFIG.mouseWheelScrollRows);
      assert.ok(below.warnings.some((w) => w.includes("mouseWheelScrollRows")));
      assert.ok(above.warnings.some((w) => w.includes("mouseWheelScrollRows")));
    });
  });
});

test("null field value warns and falls back to the default value", () => {
  const mod = realModule();
  withConfigFile("null-field.json", { enabled: null }, (file) => {
    const result = mod.loadStickyInputConfig({ paths: [file] });
    assert.equal(result.config.enabled, mod.DEFAULT_STICKY_INPUT_CONFIG.enabled);
    assert.ok(result.warnings.some((w) => w.includes("enabled")));
  });
});

test("empty project config object does not reset the global layer", () => {
  const mod = realModule();
  withConfigFile("global.json", { mouseWheelScrollRows: 7, enabled: false }, (globalFile) => {
    withConfigFile("project-empty.json", {}, (projectFile) => {
      const result = mod.loadStickyInputConfig({ paths: [globalFile, projectFile] });
      assert.equal(result.config.mouseWheelScrollRows, 7);
      assert.equal(result.config.enabled, false);
      assert.equal(result.warnings.length, 0);
    });
  });
});
