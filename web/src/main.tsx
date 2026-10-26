// SPDX-License-Identifier: LGPL-3.0-only
import { render } from "@solidjs/web";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { appControl } from "./app-control.ts";
import { App } from "./ui/App.tsx";

const root = document.getElementById("app");
if (!root) throw new Error("Missing relay root");
render(() => {
  const control = appControl();
  return (
    <App
      access={control.accessState()}
      keys={control.keysState()}
      screen={control.routeState().screen}
      routeError={control.routeState().error}
      messaging={control.messagingState()}
      relays={control.relayState()}
      room={control.roomState()}
      activeDialog={control.activeDialog()}
      relayOptions={control.relayOptions()}
      progress={control.progress()}
      waiting={control.waiting()}
      logoutConfirm={control.logoutConfirm()}
      config={control.config()}
      theme={control.theme.state()}
      themeControl={control.theme}
      actions={control.actions}
    />
  );
}, root);
