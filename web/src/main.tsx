// SPDX-License-Identifier: LGPL-3.0-only
import { createSignal } from "solid-js";
import { render } from "@solidjs/web";

function Counter() {
  const [count, setCount] = createSignal(0);
  return (
    <button type="button" onClick={() => setCount((value) => value + 1)}>
      {count()}
    </button>
  );
}

const root = document.getElementById("app");
if (!root) throw new Error("Missing counter root");
render(() => <Counter />, root);
