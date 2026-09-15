// Small DOM helpers for the page. Text is always set as text, never parsed as HTML: test names, tracebacks
// and logs come from apworld code.

const PROPERTIES = new Set(["value", "checked", "disabled", "open", "max", "min", "indeterminate"]);

/** h("div", {class: "x", onclick: fn}, child, "text") */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (PROPERTIES.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of [children].flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** A pass/fail/running marker. It's aria-hidden: the words beside it carry the meaning. */
export const dot = (state = "") => h("span", { class: `state ${state}`.trim(), "aria-hidden": "true" });

export function setDot(el, state = "") {
  el.className = `state ${state}`.trim();
}

export function formatSeconds(seconds) {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}

/** The last characters of a long text, marked as cut. */
export const tail = (text, limit = 6000) => (text.length <= limit ? text : `[…]\n${text.slice(-limit)}`);
