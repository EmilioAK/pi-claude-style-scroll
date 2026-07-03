/**
 * Shared type-guard utilities for pi-sticky-input.
 *
 * Consolidates the per-module `isRecord` type guards that were duplicated across
 * `config/config.ts` and `tui/terminal-session.ts`.
 *
 * A record is a non-null, non-array object. Arrays are intentionally excluded
 * because they are not string-keyed records. Every call site only accesses
 * string-keyed properties (which are `undefined` on arrays), so rejecting
 * arrays is observably equivalent to the previous permissive variant in
 * `terminal-session.ts`.
 */

/** Record of string keys to unknown values. */
export type JsonRecord = Record<string, unknown>;

/**
 * Type guard: true when `value` is a non-array, non-null object.
 */
export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
