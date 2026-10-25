// SPDX-License-Identifier: LGPL-3.0-only
import { ApiError } from "./api.ts";
import type {
  Account,
  ChatDetail,
  ChatRow,
  Contact,
  Invite,
  Message,
  MessagingApi,
} from "./messaging-types.ts";
import type { EventFeed } from "./events.ts";
import { Drafts } from "./composer.ts";
import { connectivity } from "./status.ts";
export interface MessagingState {
  account: Account | null;
  stream: boolean;
  connection: string;
  loading: boolean;
  error: string;
  displayName: string;
  relay: string;
  creating: boolean;
  identityError: string;
  contacts: Contact[];
  invite: Invite | null;
  qrUrl: string;
  link: string;
  contactBusy: boolean;
  contactError: string;
  notice: string;
  chats: ChatRow[];
  chatId: number | null;
  chat: ChatDetail | null;
  messages: Message[];
  historyBusy: boolean;
  hasEarlier: boolean;
  draft: string;
  sending: boolean;
  sendError: string;
  selected: number[];
  confirmDelete: boolean;
}
export const initialMessaging = (): MessagingState => ({
  account: null,
  stream: false,
  connection: "Checking relay…",
  loading: true,
  error: "",
  displayName: "",
  relay: "",
  creating: false,
  identityError: "",
  contacts: [],
  invite: null,
  qrUrl: "",
  link: "",
  contactBusy: false,
  contactError: "",
  notice: "",
  chats: [],
  chatId: null,
  chat: null,
  messages: [],
  historyBusy: false,
  hasEarlier: true,
  draft: "",
  sending: false,
  sendError: "",
  selected: [],
  confirmDelete: false,
});
export class Messaging {
  state = initialMessaging();
  readonly drafts = new Drafts();
  #epoch = 0;
  #selection = 0;
  #historyRequest = 0;
  #active = false;
  #dirty = false;
  #running = false;
  #wanted = 30;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #sent = new Set<number>();
  #sendingChats = new Set<number>();
  constructor(
    private api: MessagingApi,
    private feed: EventFeed,
    private publish: (state: MessagingState) => void,
    private unauthorized: () => void,
    private navigate: (chatId: number) => void,
    private clipboard: (text: string) => Promise<void>,
  ) {}
  private patch(value: Partial<MessagingState>) {
    this.state = { ...this.state, ...value };
    this.state.connection = connectivity(this.state.account, this.state.stream);
    this.publish(this.state);
  }
  get dirty() {
    return this.drafts.dirty || !!this.state.displayName ||
      !!this.state.relay || !!this.state.link || this.state.creating ||
      this.state.sending;
  }
  start() {
    if (this.#active) return;
    this.#active = true;
    this.feed.start(
      () => this.invalidate(),
      (stream) => this.patch({ stream }),
    );
    void this.refresh();
  }
  stop(clear = false) {
    this.#epoch++;
    this.#selection++;
    this.#active = false;
    this.feed.close();
    clearTimeout(this.#timer);
    this.#dirty = false;
    this.#sent.clear();
    this.#sendingChats.clear();
    if (clear) {
      this.drafts.clear();
      this.state = initialMessaging();
      this.publish(this.state);
    }
  }
  invalidate() {
    if (!this.#active) return;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => void this.refresh(), 80);
  }
  private failed(error: unknown) {
    if (error instanceof ApiError && error.status === 401) this.unauthorized();
    return error instanceof Error
      ? error.message
      : "Request failed. Try again.";
  }
  async refresh() {
    this.#dirty = true;
    if (this.#running || !this.#active) return;
    this.#running = true;
    const epoch = this.#epoch;
    try {
      while (this.#dirty && this.#active && epoch === this.#epoch) {
        this.#dirty = false;
        try {
          const account = await this.api.account();
          if (epoch !== this.#epoch) return;
          this.patch({ account, loading: false, error: "" });
          if (!account.configured || account.core !== "ready") continue;
          const [contacts, chats] = await Promise.all([
            this.api.contacts(),
            this.api.chats(),
          ]);
          if (epoch !== this.#epoch) return;
          this.patch({ contacts: contacts.contacts, chats: chats.chats });
          if (!this.state.invite) {
            const invite = await this.api.invite();
            if (epoch !== this.#epoch) return;
            this.patch({
              invite,
              qrUrl: `data:image/svg+xml,${encodeURIComponent(invite.svg)}`,
            });
          }
          await this.history();
        } catch (error) {
          if (epoch === this.#epoch) {
            this.patch({ loading: false, error: this.failed(error) });
          }
        }
      }
    } finally {
      this.#running = false;
      if (this.#dirty && this.#active) void this.refresh();
    }
  }
  select(chatId: number | null) {
    if (this.state.chatId === chatId) return;
    const selection = ++this.#selection;
    this.#wanted = 30;
    this.#sent.clear();
    this.patch({
      chatId,
      chat: null,
      messages: [],
      draft: chatId ? this.drafts.get(chatId).text : "",
      sendError: "",
      sending: chatId ? this.#sendingChats.has(chatId) : false,
      selected: [],
      confirmDelete: false,
      historyBusy: !!chatId,
      hasEarlier: true,
    });
    if (chatId && this.#active) {
      void this.history().catch((error) => {
        if (selection === this.#selection) {
          this.patch({ historyBusy: false, error: this.failed(error) });
        }
      });
    }
  }
  async history() {
    const chatId = this.state.chatId,
      selection = this.#selection,
      epoch = this.#epoch,
      request = ++this.#historyRequest;
    if (!chatId || !this.#active) return;
    const chat = await this.api.chat(chatId);
    let messages: Message[] = [], before: number | undefined, hasEarlier = true;
    while (messages.length < this.#wanted && hasEarlier) {
      const page = (await this.api.messages(chatId, before)).messages;
      hasEarlier = page.length === 30;
      messages = [...page, ...messages];
      before = page[0]?.id;
    }
    if (
      epoch !== this.#epoch || selection !== this.#selection ||
      request !== this.#historyRequest
    ) return;
    const unique = [
      ...new Map(messages.map((message) => [message.id, message])).values(),
    ];
    this.patch({
      chat,
      messages: unique,
      hasEarlier,
      historyBusy: false,
      selected: this.state.selected.filter((id) =>
        unique.some((message) => message.id === id)
      ),
    });
  }
  async earlier() {
    if (this.state.historyBusy) return;
    this.#wanted += 30;
    this.patch({ historyBusy: true });
    try {
      await this.history();
    } catch (error) {
      this.patch({ historyBusy: false, error: this.failed(error) });
    }
  }
  presented(ids: number[]) {
    const chat = this.state.chatId;
    if (!chat) return;
    const selected = ids.filter((id) =>
      !this.#sent.has(id) &&
      this.state.messages.some((message) =>
        message.id === id && !message.fromSelf && message.state !== "seen"
      )
    );
    if (!selected.length) return;
    selected.forEach((id) => this.#sent.add(id));
    const epoch = this.#epoch;
    void this.api.seen(chat, selected).catch((error) => {
      if (epoch === this.#epoch) {
        selected.forEach((id) => this.#sent.delete(id));
        this.patch({ error: this.failed(error) });
      }
    });
  }
  identityField(name: "relay" | "displayName", value: string) {
    this.patch({ [name]: value });
  }
  async create() {
    if (this.state.creating) return;
    const epoch = this.#epoch,
      input = { relay: this.state.relay, displayName: this.state.displayName };
    this.patch({ creating: true, identityError: "" });
    try {
      await this.api.createIdentity(input);
      if (epoch !== this.#epoch) return;
      this.patch({
        relay: this.state.relay === input.relay ? "" : this.state.relay,
        displayName: this.state.displayName === input.displayName
          ? ""
          : this.state.displayName,
      });
      await this.refresh();
    } catch (error) {
      if (epoch === this.#epoch) {
        this.patch({ identityError: this.failed(error) });
      }
    } finally {
      if (epoch === this.#epoch) this.patch({ creating: false });
    }
  }
  link(value: string) {
    this.patch({ link: value });
  }
  private async contact(action: () => Promise<void>) {
    if (this.state.contactBusy) return;
    const epoch = this.#epoch;
    this.patch({ contactBusy: true, contactError: "", notice: "" });
    try {
      await action();
      if (epoch === this.#epoch) await this.refresh();
    } catch (error) {
      if (epoch === this.#epoch) {
        this.patch({ contactError: this.failed(error) });
      }
    } finally {
      if (epoch === this.#epoch) this.patch({ contactBusy: false });
    }
  }
  join() {
    const link = this.state.link, epoch = this.#epoch;
    return this.contact(async () => {
      const result = await this.api.join(link);
      if (epoch !== this.#epoch) return;
      if (this.state.link === link) this.patch({ link: "" });
      this.navigate(result.chatId);
    });
  }
  open(contact: number) {
    const epoch = this.#epoch;
    return this.contact(async () => {
      const result = await this.api.openChat(contact);
      if (epoch === this.#epoch) this.navigate(result.chatId);
    });
  }
  request(chat: number, action: "accept" | "block") {
    return this.contact(async () => {
      await this.api.request(chat, action);
    });
  }
  async copyInvite() {
    const link = this.state.invite?.link;
    if (!link) return;
    const epoch = this.#epoch;
    try {
      await this.clipboard(link);
      if (epoch === this.#epoch) this.patch({ notice: "Invitation copied." });
    } catch (error) {
      if (epoch === this.#epoch) {
        this.patch({ contactError: this.failed(error) });
      }
    }
  }
  draft(value: string) {
    const chat = this.state.chatId;
    if (!chat) return;
    this.drafts.set(chat, value);
    this.patch({ draft: value });
  }
  async send() {
    const chat = this.state.chatId;
    if (!chat || this.#sendingChats.has(chat) || !this.state.draft.trim()) {
      return;
    }
    const value = this.drafts.get(chat), epoch = this.#epoch;
    this.#sendingChats.add(chat);
    this.patch({ sending: true, sendError: "" });
    try {
      await this.api.send(chat, value.text);
      if (epoch !== this.#epoch) return;
      this.drafts.sent(chat, value.revision);
      if (this.state.chatId === chat) {
        this.patch({ draft: this.drafts.get(chat).text });
      }
      await this.refresh();
    } catch (error) {
      if (epoch === this.#epoch && this.state.chatId === chat) {
        this.patch({ sendError: this.failed(error) });
      }
    } finally {
      if (epoch === this.#epoch) {
        this.#sendingChats.delete(chat);
        if (this.state.chatId === chat) this.patch({ sending: false });
      }
    }
  }
  toggle(id: number) {
    this.patch({
      selected: this.state.selected.includes(id)
        ? this.state.selected.filter((value) => value !== id)
        : [...this.state.selected, id],
      confirmDelete: false,
    });
  }
  confirm(value: boolean) {
    this.patch({ confirmDelete: value });
  }
  async remove() {
    const epoch = this.#epoch,
      selection = this.#selection,
      ids = [...this.state.selected];
    if (!ids.length || !this.state.confirmDelete) return;
    try {
      await this.api.removeMessages(ids);
      if (epoch !== this.#epoch) return;
      if (selection === this.#selection) {
        this.patch({ selected: [], confirmDelete: false });
      }
      await this.refresh();
    } catch (error) {
      if (epoch === this.#epoch) this.patch({ error: this.failed(error) });
    }
  }
}
