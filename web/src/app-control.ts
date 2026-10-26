// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal, onSettled } from "solid-js";
import { Access, initialAccess } from "./access.ts";
import { initialKeys, Keys } from "./keys.ts";
import { browserApi } from "./api.ts";
import { copyText } from "./clipboard.ts";
import { browserLocation, openCodeConfig } from "./location.ts";
import { browserTheme } from "./theme.ts";
import { themeControl } from "./theme-control.ts";
import { initialMessaging, Messaging } from "./messaging.ts";
import { BrowserEvents } from "./events.ts";
import { historyViewport, Presentation } from "./presentation.ts";

export function appControl() {
  const api = browserApi(), page = browserLocation(), theme = browserTheme();
  const [accessState, publishAccess] = createSignal(initialAccess());
  const [keysState, publishKeys] = createSignal(initialKeys());
  const [messagingState, publishMessaging] = createSignal(initialMessaging());
  const [logoutConfirm, setLogoutConfirm] = createSignal(false);
  let signedIn = false;
  const messaging = new Messaging(
    api,
    new BrowserEvents(),
    publishMessaging,
    () => {
      void access.refresh();
    },
    (id) => page.navigate(`/chats/${id}`),
    copyText,
  );
  const presentation = new Presentation((ids) => messaging.presented(ids));
  const dirty = () =>
    messaging.dirty || !!keys.state.shown || !!keys.state.name ||
    keys.state.busy || !!access.state.password || !!access.state.code;
  page.protect(dirty);
  const logout = () => {
    setLogoutConfirm(false);
    keys.clear();
    messaging.stop(true);
    signedIn = false;
    void access.logout();
  };
  const [routeState, publishRoute] = createSignal(page.current);
  const offRoute = page.subscribe((value) => {
    publishRoute(value);
    messaging.select(value.screen === "chats" ? value.chatId : null);
    if (
      value.screen === "keys" && access.state.session?.authenticated &&
      access.state.session.mode !== "public"
    ) void keys.load();
  });
  const keys = new Keys(api, copyText, publishKeys, () => {
    void access.refresh();
  });
  const access = new Access(api, publishAccess, (session) => {
    if (session.authenticated && !session.setupRequired) {
      signedIn = true;
      messaging.select(
        page.current.screen === "chats" ? page.current.chatId : null,
      );
      messaging.start();
    } else if (signedIn) {
      signedIn = false;
      messaging.stop();
    }
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
      messaging.stop(true);
      presentation.close();
      theme.close();
    };
  });
  return {
    accessState,
    keysState,
    routeState,
    messagingState,
    logoutConfirm,
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
        if (dirty()) setLogoutConfirm(true);
        else logout();
      },
      cancelLogout: () => setLogoutConfirm(false),
      discardLogout: logout,
      identityField: (name: "relay" | "displayName", value: string) =>
        messaging.identityField(name, value),
      createIdentity: () => {
        void messaging.create();
      },
      invitation: (value: string) => messaging.link(value),
      joinContact: () => {
        void messaging.join();
      },
      openContact: (id: number) => {
        void messaging.open(id);
      },
      requestContact: (id: number, action: "accept" | "block") => {
        void messaging.request(id, action);
      },
      copyInvite: () => {
        void messaging.copyInvite();
      },
      refreshMessaging: () => {
        void messaging.refresh();
      },
      draft: (value: string) => messaging.draft(value),
      send: () => {
        void messaging.send();
      },
      earlier: () => {
        void messaging.earlier();
      },
      toggleMessage: (id: number) => messaging.toggle(id),
      confirmMessageDelete: (value: boolean) => messaging.confirm(value),
      deleteMessages: () => {
        void messaging.remove();
      },
      observeMessage: (element: Element, id: number) =>
        presentation.observe(element, id),
      bindHistory: historyViewport,
      composerKey: (event: KeyboardEvent) => {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          void messaging.send();
        }
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
        void keys.copyKey();
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
