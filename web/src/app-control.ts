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
import { initialRelays, Relays } from "./relays.ts";
import { setupProgress } from "./onboarding.ts";

export function appControl() {
  const api = browserApi(), page = browserLocation(), theme = browserTheme();
  const [accessState, publishAccess] = createSignal(initialAccess());
  const [keysState, publishKeys] = createSignal(initialKeys());
  const [messagingState, publishMessaging] = createSignal(initialMessaging());
  const [logoutConfirm, setLogoutConfirm] = createSignal(false);
  const [relayState, publishRelays] = createSignal(initialRelays());
  const relays = new Relays(api, publishRelays);
  const progress = () =>
    setupProgress(
      messagingState(),
      keysState(),
      accessState().session?.mode === "public",
    );
  const resolveLanding = () => {
    // Workflow consumes controller facts directly. Solid's render signals may
    // settle later than the publish callback that received these facts.
    if (!access.state.session?.authenticated) return;
    const next = setupProgress(
      messaging.state,
      keys.state,
      access.state.session.mode === "public",
    ).next;
    if (next) page.resolveDefault(next);
  };
  let signedIn = false;
  const messaging = new Messaging(
    api,
    new BrowserEvents(),
    (value) => {
      publishMessaging(value);
      resolveLanding();
    },
    () => {
      void access.refresh();
    },
    (id) => page.navigate(`/chats/${id}`),
    copyText,
  );
  const presentation = new Presentation((ids) => messaging.presented(ids));
  const dirty = () =>
    messaging.dirty || (!messaging.state.account?.configured && relays.dirty) ||
    !!keys.state.shown ||
    !!keys.state.name ||
    keys.state.busy || !!access.state.password || !!access.state.code;
  page.protect(dirty);
  const logout = () => {
    setLogoutConfirm(false);
    keys.clear();
    relays.clear();
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
    resolveLanding();
  });
  const keys = new Keys(api, copyText, (value) => {
    publishKeys(value);
    resolveLanding();
  }, () => {
    void access.refresh();
  });
  const access = new Access(api, publishAccess, (session) => {
    if (session.authenticated && !session.setupRequired) {
      const starting = !signedIn;
      signedIn = true;
      if (starting) {
        void relays.load();
        if (session.mode !== "public") void keys.load();
      }
      messaging.select(
        page.current.screen === "chats" ? page.current.chatId : null,
      );
      messaging.start();
    } else if (signedIn) {
      signedIn = false;
      messaging.stop();
    }
    resolveLanding();
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
    relayState,
    relayOptions: () => {
      relayState();
      return relays.options;
    },
    progress,
    waiting: () => routeState().default && !progress().next,
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
        messaging.identityField("relay", relays.value);
        void messaging.create();
      },
      relaySelect: (value: string) => relays.select(value),
      relayCustom: (value: string) => {
        relays.custom(value);
        messaging.identityField("relay", value);
      },
      refreshRelays: () => {
        void relays.load(true);
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
      imageEvent: (id: number, src: string, failed: boolean) =>
        messaging.imageEvent(id, src, failed),
      retryImage: (id: number) => messaging.retryImage(id),
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
