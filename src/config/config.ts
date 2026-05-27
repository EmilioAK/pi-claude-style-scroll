import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_FILE_NAME = "config.json";
const EXTENSION_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface StickyInputConfig {
  debug: boolean;
  enabled: boolean;
  splitFooterRenderer: boolean;
  alternateScreen: boolean;
  alternateScroll: boolean;
  mouseScroll: boolean;
  mouseWheelScrollRows: number;
  keyboardScroll: boolean;
  keyboardScrollRows: number;
  minimumHistoryRows: number;
  historyViewportLineLimit: number;
}

export interface StickyInputConfigLoadResult {
  config: StickyInputConfig;
  warnings: string[];
}

export const DEFAULT_STICKY_INPUT_CONFIG: StickyInputConfig = {
  debug: false,
  enabled: true,
  splitFooterRenderer: true,
  alternateScreen: true,
  alternateScroll: false,
  mouseScroll: false,
  mouseWheelScrollRows: 3,
  keyboardScroll: true,
  keyboardScrollRows: 10,
  minimumHistoryRows: 3,
  historyViewportLineLimit: 200,
};

export function getExtensionRoot(): string {
  return EXTENSION_ROOT;
}

export function getConfigPath(): string {
  return join(getExtensionRoot(), CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneDefaultConfig(): StickyInputConfig {
  return { ...DEFAULT_STICKY_INPUT_CONFIG };
}

function formatValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function parseBoolean(
  value: unknown,
  fallback: boolean,
  field: string,
  warnings: string[],
): boolean {
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    warnings.push(`Invalid pi-sticky-input config setting '${field}': expected a boolean, got ${formatValue(value)}.`);
    return fallback;
  }

  return value;
}

function parseBoundedInteger(
  value: unknown,
  fallback: number,
  field: string,
  min: number,
  max: number,
  warnings: string[],
): number {
  if (value === undefined) {
    return fallback;
  }

  if (!Number.isInteger(value) || typeof value !== "number" || value < min || value > max) {
    warnings.push(
      `Invalid pi-sticky-input config setting '${field}': expected an integer between ${min} and ${max}, got ${formatValue(value)}.`,
    );
    return fallback;
  }

  return value;
}

function normalizeConfig(rawConfig: unknown): StickyInputConfigLoadResult {
  const warnings: string[] = [];
  const defaults = DEFAULT_STICKY_INPUT_CONFIG;

  if (!isRecord(rawConfig)) {
    warnings.push("Invalid pi-sticky-input config root: expected a JSON object. Using defaults.");
    return { config: cloneDefaultConfig(), warnings };
  }

  return {
    config: {
      debug: parseBoolean(rawConfig.debug, defaults.debug, "debug", warnings),
      enabled: parseBoolean(rawConfig.enabled, defaults.enabled, "enabled", warnings),
      splitFooterRenderer: parseBoolean(
        rawConfig.splitFooterRenderer,
        defaults.splitFooterRenderer,
        "splitFooterRenderer",
        warnings,
      ),
      alternateScreen: parseBoolean(
        rawConfig.alternateScreen,
        defaults.alternateScreen,
        "alternateScreen",
        warnings,
      ),
      alternateScroll: parseBoolean(
        rawConfig.alternateScroll,
        defaults.alternateScroll,
        "alternateScroll",
        warnings,
      ),
      mouseScroll: parseBoolean(
        rawConfig.mouseScroll,
        defaults.mouseScroll,
        "mouseScroll",
        warnings,
      ),
      mouseWheelScrollRows: parseBoundedInteger(
        rawConfig.mouseWheelScrollRows,
        defaults.mouseWheelScrollRows,
        "mouseWheelScrollRows",
        1,
        50,
        warnings,
      ),
      keyboardScroll: parseBoolean(
        rawConfig.keyboardScroll,
        defaults.keyboardScroll,
        "keyboardScroll",
        warnings,
      ),
      keyboardScrollRows: parseBoundedInteger(
        rawConfig.keyboardScrollRows,
        defaults.keyboardScrollRows,
        "keyboardScrollRows",
        1,
        200,
        warnings,
      ),
      minimumHistoryRows: parseBoundedInteger(
        rawConfig.minimumHistoryRows,
        defaults.minimumHistoryRows,
        "minimumHistoryRows",
        1,
        20,
        warnings,
      ),
      historyViewportLineLimit: parseBoundedInteger(
        rawConfig.historyViewportLineLimit,
        defaults.historyViewportLineLimit,
        "historyViewportLineLimit",
        20,
        5000,
        warnings,
      ),
    },
    warnings,
  };
}

export function loadStickyInputConfig(path = getConfigPath()): StickyInputConfigLoadResult {
  if (!existsSync(path)) {
    return { config: cloneDefaultConfig(), warnings: [] };
  }

  try {
    const rawConfig = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return normalizeConfig(rawConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: cloneDefaultConfig(),
      warnings: [`Failed to read pi-sticky-input config at '${path}': ${message}. Using defaults.`],
    };
  }
}
