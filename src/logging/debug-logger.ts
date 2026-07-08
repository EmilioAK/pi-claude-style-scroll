import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { getExtensionRoot, type StickyInputConfig } from "../config/config.js";

const DEBUG_DIRECTORY_NAME = "debug";
const DEBUG_LOG_FILE_NAME = "debug.log";
const EXTENSION_ID = "pi-claude-style-scroll";
const SECRET_KEYS = /api[_-]?key|authorization|token|secret|password/i;

type DebugFields = Record<string, unknown>;

interface DebugLoggerCreateOptions {
  extensionRoot?: string;
}

function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(value, (key, currentValue: unknown) => {
    if (SECRET_KEYS.test(key)) {
      return "[REDACTED]";
    }

    if (currentValue instanceof Error) {
      return {
        name: currentValue.name,
        message: currentValue.message,
        stack: currentValue.stack,
      };
    }

    if (typeof currentValue === "bigint") {
      return currentValue.toString();
    }

    if (typeof currentValue === "object" && currentValue !== null) {
      if (seen.has(currentValue)) {
        return "[Circular]";
      }

      seen.add(currentValue);
    }

    return currentValue;
  });
}

export class DebugLogger {
  private readonly debugDirectory: string | undefined;
  private readonly logPath: string | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly enabled: boolean, extensionRoot = getExtensionRoot()) {
    this.debugDirectory = enabled ? join(extensionRoot, DEBUG_DIRECTORY_NAME) : undefined;
    this.logPath = enabled ? join(extensionRoot, DEBUG_DIRECTORY_NAME, DEBUG_LOG_FILE_NAME) : undefined;
  }

  static create(config: StickyInputConfig, options: DebugLoggerCreateOptions = {}): DebugLogger {
    return new DebugLogger(config.debug, options.extensionRoot);
  }

  log(event: string, fields: DebugFields = {}): string | undefined {
    if (!this.enabled || !this.debugDirectory || !this.logPath) {
      return undefined;
    }

    const line = `${safeJsonStringify({ timestamp: new Date().toISOString(), extension: EXTENSION_ID, event, ...fields })}\n`;
    this.writeQueue = this.writeQueue.then(
      () => this.appendLine(line),
      () => this.appendLine(line),
    );
    void this.writeQueue.catch(() => {
      // Debug logging must never affect pi-claude-style-scroll behavior or terminal output.
    });
    return undefined;
  }

  flush(): Promise<void> {
    return this.writeQueue.catch(() => undefined);
  }

  private async appendLine(line: string): Promise<void> {
    if (!this.debugDirectory || !this.logPath) {
      return;
    }
    await mkdir(this.debugDirectory, { recursive: true });
    await appendFile(this.logPath, line, "utf-8");
  }
}
