// Short text forms of preview values and inputs (DESIGN.md §6.9).

import type {
  PreviewCaseInput,
} from "@/lib/preview/types";

export function short(sha: string): string {
  return sha.slice(0, 7);
}

export function compact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One value at a glance: scalars as they are (long strings clipped), objects and lists as their shape. */
export function glance(value: unknown): string {
  if (Array.isArray(value)) return value.length === 0 ? "[]" : `[${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    // Tagged values the harness revives ({"$undefined": true}, {"$date": "…"}, …).
    if (keys.length === 1 && keys[0].startsWith("$")) {
      const inner = (value as Record<string, unknown>)[keys[0]];
      if (keys[0] === "$undefined") return "undefined";
      if (keys[0] === "$fn" || keys[0] === "$function") return "ƒ";
      return `${keys[0].slice(1)}(${glance(inner)})`;
    }
    return keys.length === 0 ? "{}" : `{${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  const text = compact(value);
  return text.length > 40 ? `${text.slice(0, 39)}…"` : text;
}

/** `status: "analyzing" · repoId: "repo-123"`, or `1, 1` for arguments. The full JSON is behind Edit. */
export function readableInput(item: PreviewCaseInput): string {
  const { props, args, kwargs } = item.input;
  if (props) {
    const entries = Object.entries(props);
    return entries.length === 0 ? "no props" : entries.map(([k, v]) => `${k}: ${glance(v)}`).join(" · ");
  }
  const parts = (args ?? []).map(glance);
  for (const [k, v] of Object.entries(kwargs ?? {})) parts.push(`${k}=${glance(v)}`);
  return parts.length === 0 ? "no arguments" : parts.join(", ");
}
