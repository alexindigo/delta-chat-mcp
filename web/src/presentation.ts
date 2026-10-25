// SPDX-License-Identifier: LGPL-3.0-only
import type { Contact, Message } from "./messaging-types.ts";
export const messageTime = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
export const sender = (message: Message, contacts: Contact[]) =>
  message.fromSelf
    ? "You"
    : contacts.find((contact) => contact.id === message.fromContactId)
      ?.displayName || `Contact ${message.fromContactId}`;
/** Visibility is observed at the browser consumer, not inferred from an API GET. */
export class Presentation {
  #observer: IntersectionObserver;
  #visible = new Map<Element, number>();
  #ids = new WeakMap<Element, number>();
  constructor(private shown: (ids: number[]) => void) {
    this.#observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = this.#ids.get(entry.target);
        if (id === undefined) continue;
        if (entry.isIntersecting && entry.intersectionRatio >= .25) {
          this.#visible.set(entry.target, id);
        } else this.#visible.delete(entry.target);
      }
      this.flush();
    }, { threshold: [0, .25] });
    document.addEventListener("visibilitychange", this.flush);
  }
  private flush = () => {
    if (document.visibilityState === "visible") {
      this.shown([...this.#visible.values()]);
    }
  };
  observe(element: Element, id: number) {
    this.#ids.set(element, id);
    this.#observer.observe(element);
    return () => {
      this.#observer.unobserve(element);
      this.#visible.delete(element);
      this.#ids.delete(element);
    };
  }
  close() {
    this.#observer.disconnect();
    this.#visible.clear();
    document.removeEventListener("visibilitychange", this.flush);
  }
}
/** Injected scroll capability; owns only the supplied history viewport. */
export function historyViewport(element: HTMLElement) {
  let height = element.scrollHeight, follow = true;
  const scroll = () => {
    follow =
      element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
    height = element.scrollHeight;
  };
  const observer = new MutationObserver(() => {
    const next = element.scrollHeight;
    if (follow) element.scrollTop = next;
    else if (next > height) element.scrollTop += next - height;
    height = next;
  });
  observer.observe(element, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  const frame = requestAnimationFrame(() => {
    element.scrollTop = element.scrollHeight;
    height = element.scrollHeight;
  });
  element.addEventListener("scroll", scroll, { passive: true });
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    element.removeEventListener("scroll", scroll);
  };
}
