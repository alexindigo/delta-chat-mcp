// SPDX-License-Identifier: LGPL-3.0-only
import bundled from "../../defaults/public-relays.json" with { type: "json" };

export interface PublicRelay {
  domain: string;
  homepage: string;
}
export interface RelayCatalog {
  source: string;
  retrieved: string;
  relays: PublicRelay[];
}
export interface RelayResult extends RelayCatalog {
  refreshed: boolean;
  notice: string;
}
export const directoryURL = "https://chatmail.at/relays";
const responseLimit = 128 * 1024;

// Deliberately a constrained directory recognizer, not a general HTML renderer.
// Only the first list after the known heading is data; no prose is redistributed.
function attributes(tag: string) {
  const attrs = new Map<string, string>();
  for (
    const match of tag.matchAll(
      /([a-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    )
  ) {
    const key = match[1].toLowerCase();
    if (attrs.has(key)) throw new Error("Duplicate attribute");
    attrs.set(key, match[2] ?? match[3] ?? match[4]);
  }
  return attrs;
}
export function parseRelayDirectory(html: string): PublicRelay[] {
  const clean = html.replace(
    /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    "",
  );
  const heading = [...clean.matchAll(/<h[12]\b([^>]*)>[\s\S]*?<\/h[12]\s*>/gi)]
    .find((match) =>
      attributes(match[1]).get("id") === "how-to-select-a-chatmail-relay"
    );
  if (!heading) throw new Error("Directory heading unrecognized");
  const after = clean.slice(heading.index! + heading[0].length);
  const list = /^[\s\S]*?<ul\b[^>]*>([\s\S]*?)<\/ul\s*>/i.exec(after);
  if (!list || /<h[1-6]\b/i.test(list[0])) {
    throw new Error("Directory list unrecognized");
  }
  const records = new Map<string, PublicRelay>();
  for (const item of list[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)) {
    for (const anchor of item[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
      const attrs = attributes(anchor[1]);
      if (!attrs.get("class")?.split(/\s+/).includes("hilite")) continue;
      const domain = anchor[2].trim().toLowerCase();
      if (
        domain.length > 253 ||
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
      ) throw new Error("Invalid relay domain");
      const href = attrs.get("href") ?? "";
      if (!/^https:\/\/[a-z0-9.-]+\/?$/i.test(href)) {
        throw new Error("Invalid relay homepage");
      }
      const url = new URL(href);
      if (url.hostname !== domain) throw new Error("Mismatched relay domain");
      records.set(domain, { domain, homepage: url.href });
    }
  }
  if (!records.size || records.size > 100) {
    throw new Error("Empty or oversized relay list");
  }
  return [...records.values()];
}

/** One bounded upstream capability and memory-only last-good cache per service. */
export class PublicRelays {
  #catalog: RelayCatalog = structuredClone(bundled);
  #pending?: Promise<RelayResult>;
  #lifetime = new AbortController();
  constructor(private fetcher: typeof fetch = fetch, private timeout = 5000) {}
  snapshot(): RelayCatalog {
    return structuredClone(this.#catalog);
  }
  close() {
    this.#lifetime.abort();
  }
  refresh(): Promise<RelayResult> {
    return this.#pending ??= this.update().finally(() =>
      this.#pending = undefined
    );
  }
  private async update(): Promise<RelayResult> {
    const signal = AbortSignal.any([
      this.#lifetime.signal,
      AbortSignal.timeout(this.timeout),
    ]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(directoryURL, {
        signal,
        redirect: "error",
        headers: { accept: "text/html" },
      });
      reader = response.body?.getReader();
      if (
        !response.ok ||
        !response.headers.get("content-type")?.includes("text/html") || !reader
      ) throw new Error("Directory unavailable");
      let size = 0, html = "";
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > responseLimit) {
          throw new Error("Directory response too large");
        }
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
      this.#catalog = {
        source: directoryURL,
        retrieved: new Date().toISOString().slice(0, 10),
        relays: parseRelayDirectory(html),
      };
      return {
        ...this.snapshot(),
        refreshed: true,
        notice: "Public-relay list refreshed.",
      };
    } catch {
      return {
        ...this.snapshot(),
        refreshed: false,
        notice:
          "Could not refresh the directory. The last included list is still available.",
      };
    } finally {
      await reader?.cancel().catch(() => {});
    }
  }
}
