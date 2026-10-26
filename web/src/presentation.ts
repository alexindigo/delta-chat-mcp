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
  let follow = true;
  let position = element.scrollTop;
  let anchor: { id: string; top: number } | undefined;
  const rows =
    () => [...element.querySelectorAll<HTMLElement>("[data-message-id]")];
  const top = (row: Element) =>
    row.getBoundingClientRect().top - element.getBoundingClientRect().top;
  const remember = () => {
    const row = rows().find((row) =>
      top(row) + row.getBoundingClientRect().height > 0
    );
    anchor = row ? { id: row.dataset.messageId!, top: top(row) } : undefined;
  };
  const scroll = () => {
    position = element.scrollTop;
    follow =
      element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
    remember();
  };
  const adjust = () => {
    // Scroll events are delivered asynchronously. A user/programmatic scroll
    // may precede a mutation/resize callback in the same frame; honor its new
    // position before applying the retained follow/anchor policy.
    if (Math.abs(element.scrollTop - position) > 1) scroll();
    if (follow) element.scrollTop = element.scrollHeight;
    else if (anchor) {
      const row = rows().find((row) => row.dataset.messageId === anchor!.id);
      if (row) element.scrollTop += top(row) - anchor.top;
    }
    remember();
    position = element.scrollTop;
  };
  // Same capability owner handles both DOM changes and late intrinsic sizing.
  // Anchor displacement, not total height, distinguishes growth above/below.
  const resize = new ResizeObserver(adjust);
  const watch = () => {
    resize.disconnect();
    resize.observe(element);
    for (const row of rows()) resize.observe(row);
    adjust();
  };
  const observer = new MutationObserver(watch);
  observer.observe(element, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  const frame = requestAnimationFrame(() => {
    element.scrollTop = element.scrollHeight;
    watch();
  });
  element.addEventListener("scroll", scroll, { passive: true });
  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    resize.disconnect();
    element.removeEventListener("scroll", scroll);
  };
}
