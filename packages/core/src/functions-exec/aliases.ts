import { type JsonValue, type NestedToolName } from "./protocol";
import { parseCodexPatch } from "./patch";

export type CanonicalNestedToolDispatcher = (name: NestedToolName, args: JsonValue) => Promise<JsonValue>;

type Arguments = Record<string, unknown>;

function object(value: unknown, alias: string): Arguments {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(alias + " arguments must be a plain object");
  }
  return value as Arguments;
}

function exactKeys(args: Arguments, alias: string, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(alias + " has an unknown argument: " + key);
  }
}

function requiredString(args: Arguments, alias: string, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(alias + "." + field + " must be a non-empty string");
  return value;
}

function optionalString(args: Arguments, alias: string, field: string): string | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(alias + "." + field + " must be a string");
  return value;
}

function optionalBoolean(args: Arguments, alias: string, field: string): boolean | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(alias + "." + field + " must be a boolean");
  return value;
}

function optionalInteger(args: Arguments, alias: string, field: string, minimum: number, maximum: number): number | undefined {
  const value = args[field];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(alias + "." + field + " must be an integer from " + minimum + " to " + maximum);
  }
  return value as number;
}

function setIfDefined(target: Arguments, field: string, value: unknown): void {
  if (value !== undefined) target[field] = value;
}

function bashArguments(value: unknown): JsonValue {
  const args = object(value, "bash");
  exactKeys(args, "bash", ["command", "timeoutMs", "runInBackground", "justification", "allowNetwork", "dangerouslyDisableSandbox"]);
  const canonical: Arguments = { command: requiredString(args, "bash", "command") };
  setIfDefined(canonical, "timeoutMs", optionalInteger(args, "bash", "timeoutMs", 1, 600_000));
  setIfDefined(canonical, "runInBackground", optionalBoolean(args, "bash", "runInBackground"));
  setIfDefined(canonical, "justification", optionalString(args, "bash", "justification"));
  setIfDefined(canonical, "allowNetwork", optionalBoolean(args, "bash", "allowNetwork"));
  setIfDefined(canonical, "dangerouslyDisableSandbox", optionalBoolean(args, "bash", "dangerouslyDisableSandbox"));
  return canonical as JsonValue;
}

function readArguments(value: unknown): JsonValue {
  const args = object(value, "read");
  exactKeys(args, "read", ["path", "offset", "limit", "pages"]);
  const canonical: Arguments = { path: requiredString(args, "read", "path") };
  setIfDefined(canonical, "offset", optionalInteger(args, "read", "offset", 0, 1_000_000));
  setIfDefined(canonical, "limit", optionalInteger(args, "read", "limit", 1, 1_000_000));
  setIfDefined(canonical, "pages", optionalString(args, "read", "pages"));
  return canonical as JsonValue;
}

function webFetchArguments(value: unknown): JsonValue {
  const args = object(value, "web_fetch");
  exactKeys(args, "web_fetch", ["url"]);
  return { url: requiredString(args, "web_fetch", "url") };
}

function webSearchArguments(value: unknown): JsonValue {
  const args = object(value, "web_search");
  exactKeys(args, "web_search", ["query", "max_results"]);
  const canonical: Arguments = { query: requiredString(args, "web_search", "query") };
  setIfDefined(canonical, "max_results", optionalInteger(args, "web_search", "max_results", 1, 100));
  return canonical as JsonValue;
}

/** Strictly converts only the five JavaScript bridge aliases into canonical Norma tool calls. */
export function normalizeFunctionsExecAlias(alias: NestedToolName, args: JsonValue): { name: NestedToolName; args: JsonValue } {
  switch (alias) {
    case "bash":
      return { name: "bash", args: bashArguments(args) };
    case "read":
      return { name: "read", args: readArguments(args) };
    case "web_fetch":
      return { name: "web_fetch", args: webFetchArguments(args) };
    case "web_search":
      return { name: "web_search", args: webSearchArguments(args) };
    case "edit":
      if (typeof args !== "string") throw new Error("edit arguments must be a raw Codex patch string");
      parseCodexPatch(args);
      return { name: "edit", args: { patch: args } };
  }
}

export async function dispatchFunctionsExecAlias(
  alias: NestedToolName,
  args: JsonValue,
  dispatch: CanonicalNestedToolDispatcher,
): Promise<JsonValue> {
  const canonical = normalizeFunctionsExecAlias(alias, args);
  return dispatch(canonical.name, canonical.args);
}
