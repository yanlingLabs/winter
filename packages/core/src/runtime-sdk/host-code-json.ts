/** Structural equality for host-observed JSON; object insertion order is not authority. */
export function canonicalHostJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalHostJson).join(",")}]`;
  return `{${Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => `${JSON.stringify(key)}:${canonicalHostJson(item)}`).join(",")}}`;
}
