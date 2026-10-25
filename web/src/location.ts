// SPDX-License-Identifier: LGPL-3.0-only
export type Screen = "keys" | "identity" | "contacts" | "chats" | "status";
export interface Route {
  screen: Screen;
  chatId: number | null;
  error: string;
  href: string;
}
export function route(url: URL): Route {
  const parts = url.pathname.split("/").filter(Boolean),
    name = parts[0] ?? "keys";
  const screen =
    (["keys", "identity", "contacts", "chats", "status"].includes(name)
      ? name
      : "keys") as Screen;
  const selected = screen === "chats"
    ? (parts[1] ?? url.searchParams.get("chat"))
    : null;
  const valid = selected === null ||
    (/^[1-9][0-9]*$/.test(selected) && Number.isSafeInteger(Number(selected)));
  return {
    screen,
    chatId: valid && selected !== null ? Number(selected) : null,
    error: !valid
      ? "Invalid conversation link. Choose a chat from the list."
      : parts.length > (screen === "chats" ? 2 : 1) || name !== screen
      ? "Page not found. Choose a screen from the navigation."
      : "",
    href: url.pathname + url.search + url.hash,
  };
}
/** Single location/history/departure owner. In-app links preserve controller memory. */
export function browserLocation() {
  let current = route(new URL(location.href));
  const listeners = new Set<(value: Route) => void>();
  let dirty = () => false;
  const emit = () => {
    current = route(new URL(location.href));
    for (const fn of listeners) fn(current);
  };
  const navigate = (path: string) => {
    const url = new URL(path, location.href);
    if (url.origin !== location.origin) return;
    history.pushState(null, "", url);
    emit();
  };
  const click = (event: MouseEvent) => {
    if (
      event.defaultPrevented || event.button !== 0 || event.ctrlKey ||
      event.metaKey || event.shiftKey || event.altKey
    ) return;
    const anchor = event.target instanceof Element
      ? event.target.closest<HTMLAnchorElement>("a[href]")
      : null;
    if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
    const url = new URL(anchor.href);
    if (
      url.origin !== location.origin ||
      !/^\/(keys|identity|contacts|chats|status)?(\/|$)/.test(url.pathname)
    ) return;
    event.preventDefault();
    navigate(url.href);
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (dirty()) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  document.addEventListener("click", click);
  globalThis.addEventListener("popstate", emit);
  globalThis.addEventListener("beforeunload", unload);
  return {
    origin: location.origin,
    get screen() {
      return current.screen;
    },
    get current() {
      return current;
    },
    navigate,
    subscribe(fn: (value: Route) => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    protect(fn: () => boolean) {
      dirty = fn;
    },
    close() {
      listeners.clear();
      document.removeEventListener("click", click);
      globalThis.removeEventListener("popstate", emit);
      globalThis.removeEventListener("beforeunload", unload);
    },
  };
}
export function openCodeConfig(origin: string, publicMode: boolean) {
  return JSON.stringify(
    {
      mcp: {
        "delta-chat": {
          type: "remote",
          url: `${origin}/mcp`,
          oauth: false,
          ...(publicMode ? {} : {
            headers: { Authorization: "Bearer {env:DELTA_CHAT_MCP_KEY}" },
          }),
          enabled: false,
        },
      },
    },
    null,
    2,
  );
}
