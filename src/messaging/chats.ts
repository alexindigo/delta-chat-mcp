// SPDX-License-Identifier: LGPL-3.0-only
import { type CoreClient, CoreUnavailable } from "../core/client.ts";
import type { ChangeHub } from "../events.ts";
import type { AccountService } from "./account.ts";
import { type Message, toMessage } from "./message.ts";
import { requireId, requireIds } from "./validation.ts";
import { loadMessages } from "./load.ts";

export class UnknownMessageAnchor extends Error {
  constructor() {
    super("Message anchor is not in this chat's current history");
    this.name = "UnknownMessageAnchor";
  }
}
export interface MessageRange {
  afterId?: number;
  beforeId?: number;
  limit?: number;
}
export type WaitResult = { timedOut: boolean; messages: Message[] };

export class ChatsService {
  #lifetime = new AbortController();
  close(): void {
    this.#lifetime.abort();
  }
  constructor(
    private readonly core: CoreClient,
    private readonly account: AccountService,
    private readonly events: ChangeHub,
    private readonly waitMaxSeconds: number,
  ) {}
  async list() {
    const id = await this.account.id();
    return await this.core.use(async (rpc) => {
      const entries = await rpc.getChatlistEntries(id, null, null, null);
      const items = await rpc.getChatlistItemsByEntries(id, entries);
      const result = await Promise.all(entries.map(async (entry) => {
        const item = items[entry];
        if (!item || item.kind === "Error") {
          throw new Error("Unable to load chat list item");
        }
        if (item.kind !== "ChatListItem") return [];
        const full = await rpc.getFullChatById(id, item.id);
        const last = item.lastMessageId
          ? (await loadMessages(rpc, id, [item.lastMessageId])).get(
            item.lastMessageId,
          )
          : undefined;
        return [{
          id: item.id,
          name: item.name,
          type: item.chatType,
          isEncrypted: item.isEncrypted,
          isContactRequest: item.isContactRequest,
          freshMessageCount: item.freshMessageCounter,
          lastMessageId: item.lastMessageId,
          lastMessageTime: last?.timestamp ?? null,
          contactIds: full.contactIds,
          summary: item.summaryText2,
        }];
      }));
      return result.flat();
    });
  }
  async get(chatId: number) {
    requireId(chatId);
    const id = await this.account.id();
    return await this.core.use(async (rpc) => {
      const chat = await rpc.getFullChatById(id, chatId);
      return {
        id: chat.id,
        name: chat.name,
        type: chat.chatType,
        isEncrypted: chat.isEncrypted,
        isContactRequest: chat.isContactRequest,
        contactIds: chat.contactIds,
        freshMessageCount: chat.freshMessageCounter,
        canSend: chat.canSend,
      };
    });
  }
  async messages(chatId: number, range: MessageRange = {}): Promise<Message[]> {
    requireId(chatId);
    if (range.afterId !== undefined) requireId(range.afterId);
    if (range.beforeId !== undefined) requireId(range.beforeId);
    const limit = range.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new Error("Message limit must be 1..1000");
    }
    const id = await this.account.id();
    return await this.core.use(async (rpc) => {
      // Core order is authoritative; IDs and timestamps are explicitly non-monotone.
      const ids = await rpc.getMessageIds(id, chatId, false, false);
      const after = range.afterId === undefined
        ? -1
        : ids.indexOf(range.afterId);
      const before = range.beforeId === undefined
        ? ids.length
        : ids.indexOf(range.beforeId);
      if ((range.afterId !== undefined && after === -1) || before === -1) {
        throw new UnknownMessageAnchor();
      }
      const selected = ids.slice(after + 1, before);
      const page = range.afterId === undefined
        ? selected.slice(-limit)
        : selected.slice(0, limit);
      if (!page.length) return [];
      const loaded = await loadMessages(rpc, id, page);
      return page.flatMap((messageId) => {
        const message = loaded.get(messageId);
        // A concurrent deletion is absence, never a fabricated empty message.
        if (!message) return [];
        return [toMessage(message)];
      });
    });
  }
  async readMessages(
    chatId: number,
    range: MessageRange = {},
  ): Promise<Message[]> {
    const messages = await this.messages(chatId, range);
    await this.markSeen(
      messages.filter((message) => !message.fromSelf).map((message) =>
        message.id
      ),
    );
    return messages;
  }
  async markSeen(ids: readonly number[]): Promise<void> {
    const messages = requireIds(ids);
    if (!messages.length) return;
    const id = await this.account.id();
    await this.core.use((rpc) => rpc.markseenMsgs(id, messages));
  }
  async markPresented(chatId: number, ids: readonly number[]): Promise<void> {
    requireId(chatId);
    const selected = requireIds(ids);
    if (!selected.length) return;
    const accountId = await this.account.id();
    await this.core.use(async (rpc) => {
      const loaded = await loadMessages(rpc, accountId, selected);
      if ([...loaded.values()].some((message) => message.chatId !== chatId)) {
        throw new Error("Messages must belong to the displayed chat");
      }
      const incoming = [...loaded.values()].filter((message) =>
        !toMessage(message).fromSelf
      ).map((message) => message.id);
      if (incoming.length) await rpc.markseenMsgs(accountId, incoming);
    });
  }
  async waitAndRead(
    chatId: number,
    afterId: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<WaitResult> {
    const result = await this.waitForMessage(
      chatId,
      afterId,
      timeoutMs,
      signal,
    );
    signal.throwIfAborted();
    const messages = result.messages.slice(0, 100);
    await this.markSeen(
      messages.filter((message) => !message.fromSelf).map((message) =>
        message.id
      ),
    );
    return { timedOut: result.timedOut, messages };
  }
  waitForMessage(
    chatId: number,
    afterId: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WaitResult> {
    signal = AbortSignal.any([
      this.#lifetime.signal,
      ...(signal ? [signal] : []),
    ]);
    requireId(chatId);
    requireId(afterId);
    if (
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 ||
      timeoutMs > this.waitMaxSeconds * 1000
    ) return Promise.reject(new Error("Wait exceeds configured bound"));
    return new Promise<WaitResult>((resolve, reject) => {
      let done = false, running = false, dirty = false;
      const finish = (result?: WaitResult, error?: unknown) => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error !== undefined) reject(error);
        else resolve(result!);
      };
      const abort = () =>
        finish(undefined, new DOMException("Wait aborted", "AbortError"));
      const check = async () => {
        dirty = true;
        if (running || done) return;
        running = true;
        try {
          while (dirty && !done) {
            dirty = false;
            try {
              const messages = await this.messages(chatId, {
                afterId,
                limit: 1000,
              });
              if (messages.length) finish({ timedOut: false, messages });
            } catch (error) {
              if (!(error instanceof CoreUnavailable)) finish(undefined, error);
            }
          }
        } finally {
          running = false;
        }
      };
      // Install the listener before the first history read. A concurrent event
      // marks a running read dirty, so it cannot be lost between read/subscribe.
      const off = this.events.subscribe((change) => {
        if (
          change.type === "connectivity" ||
          (change.type === "messages" &&
            (change.chatId === 0 || change.chatId === chatId))
        ) return check();
      });
      const timer = setTimeout(
        () => finish({ timedOut: true, messages: [] }),
        timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else void check();
    });
  }
}
