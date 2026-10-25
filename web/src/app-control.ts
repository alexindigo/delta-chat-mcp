// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled } from "solid-js";
import { Access, initialAccess } from "./access.ts";
import { initialKeys, Keys } from "./keys.ts";
import { browserApi } from "./api.ts";
import { copyText } from "./clipboard.ts";
import { browserLocation, openCodeConfig } from "./location.ts";
import { browserTheme } from "./theme.ts";
import { themeControl } from "./theme-control.ts";

export function appControl() {
  const api = browserApi(), page = browserLocation(), theme = browserTheme();
  const [accessState, publishAccess] = createSignal(initialAccess());
  const [keysState, publishKeys] = createSignal(initialKeys());
  const [routeState, publishRoute] = createSignal(page.current);
  const offRoute = page.subscribe((value) => {
    publishRoute(value);
    if (
      value.screen === "keys" && access.state.session?.authenticated &&
      access.state.session.mode !== "public"
    ) void keys.load();
  });
  const keys = new Keys(api, copyText, publishKeys, () => {
    void access.refresh();
  });
  const access = new Access(api, publishAccess, (session) => {
    keys.clear();
    if (
      session.authenticated && session.mode !== "public" &&
      page.screen === "keys"
    ) void keys.load();
  });
  onSettled(() => {
    void access.refresh();
    return () => {
      keys.clear();
      offRoute();
      page.close();
      theme.close();
    };
  });
  return {
    accessState,
    keysState,
    routeState,
    page,
    theme: themeControl(theme),
    config: () =>
      openCodeConfig(page.origin, accessState().session?.mode === "public"),
    actions: {
      refresh: () => {
        void access.refresh();
      },
      field: (name: "username" | "password" | "code", value: string) =>
        access.field(name, value),
      mode: (mode: "public" | "password" | "totp") => access.choose(mode),
      enroll: () => {
        void access.enroll();
      },
      submit: () => {
        void access.submit();
      },
      logout: () => {
        keys.clear();
        void access.logout();
      },
      keyName: (value: string) => keys.name(value),
      createKey: () => {
        void keys.create();
      },
      dismissKey: () => keys.dismiss(),
      confirmDelete: (id: string | null) => keys.confirm(id),
      deleteKey: () => {
        void keys.remove();
      },
      copyKey: () => {
        if (keys.state.shown) void keys.copy(keys.state.shown.key);
      },
      copyConfig: () => {
        void keys.copy(
          openCodeConfig(page.origin, access.state.session?.mode === "public"),
        );
      },
      reloadKeys: () => {
        void keys.load();
      },
    },
  };
}
export type AppControl = ReturnType<typeof appControl>;
