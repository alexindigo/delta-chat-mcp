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
      config={control.config()}
      theme={control.theme.choice()}
      chooseTheme={(id) => control.theme.choose(id)}
      actions={control.actions}
    />
  );
}, root);
