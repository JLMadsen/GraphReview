// Props as a component expects them: the model's inputs with callbacks made
// functions, components and icons filled in, and route props for Next.js files.

import { NEXT_ROUTE_FILE, SPEC, awaitable, isComponentLike, noop, paramsFromRoute, projectRequire, state } from "./harness-context.mjs";

export const CALLBACK_PROP = /^(on[A-Z]|handle[A-Z]|render[A-Z]?|set[A-Z]|get[A-Z]|fetch[A-Z]|load[A-Z]|format[A-Z]|validate[A-Z]|toggle[A-Z])|(Callback|Handler|Fn|Func|Function|Action|Listener)$/;

/**
 * Props as a real caller would pass them: callback-looking props the model
 * gave as {} or a string become no-op functions; Next.js route files get
 * awaitable params/searchParams (from the route folder when missing) and
 * layouts a stand-in children.
 */
export function realisticProps(React, props) {
  const out = { ...props };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "function" || !CALLBACK_PROP.test(key)) continue;
    const placeholder =
      value === null ||
      value === undefined ||
      typeof value === "string" ||
      (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
    if (placeholder && !(key === "render" && typeof value === "boolean")) out[key] = noop;
  }
  for (const [key, value] of Object.entries(out)) {
    if (!COMPONENT_PROP.test(key) || isComponentLike(value) || React.isValidElement?.(value)) continue;
    out[key] = componentFor(React, value);
  }
  if (!NEXT_ROUTE_FILE.test(SPEC.file)) {
    for (const key of ["params", "searchParams"]) if (key in out) out[key] = awaitable(out[key]);
    return out;
  }
  out.params = awaitable(out.params ?? paramsFromRoute(SPEC.file));
  out.searchParams = awaitable(out.searchParams ?? {});
  if (/(layout|template)\.(t|j)sx?$/.test(SPEC.file) && (out.children === undefined || out.children === null)) {
    out.children = React.createElement(
      "div",
      { style: { padding: "24px", border: "1px dashed #bbb", color: "#888", fontSize: "12px", textAlign: "center" } },
      "page content"
    );
  }
  return out;
}

/** Props that take a component (an icon, a polymorphic `as`), which JSON inputs can only name. */
export const COMPONENT_PROP = /^(icon|Icon|as|component|Component|iconComponent|IconComponent)$|[a-z]Icon$|Component$/;

/** The repo's lucide-react, if it has one, for icon names given as strings. */
export function lucideIcons() {
  if (state.iconLibrary !== undefined) return state.iconLibrary;
  try {
    state.iconLibrary = projectRequire()("lucide-react");
  } catch {
    state.iconLibrary = null;
  }
  return state.iconLibrary;
}

/** A component for a component-valued prop: the named lucide icon when there is one, else a small placeholder glyph. */
export function componentFor(React, value) {
  if (typeof value === "string") {
    const name = value.replace(/Icon$/, "");
    const icon = lucideIcons()?.[value] ?? lucideIcons()?.[name] ?? lucideIcons()?.[`${name}Icon`];
    if (isComponentLike(icon)) return icon;
  }
  return function PlaceholderIcon(props) {
    return React.createElement("span", { "aria-hidden": true, className: props?.className, style: { display: "inline-block", width: "1em", height: "1em", border: "1px solid currentColor", borderRadius: "3px", opacity: 0.6 } });
  };
}
