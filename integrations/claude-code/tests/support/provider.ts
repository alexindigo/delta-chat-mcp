// SPDX-License-Identifier: LGPL-3.0-only
export interface Reply {
  text?: string;
  tool?: { name: string; input: Record<string, unknown> };
  hold?: Promise<void>;
}
/** Local scripted Anthropic wire fixture. No user account or external model. */
export class ClaudeProvider {
  readonly queue: Reply[] = [];
  readonly requests: Record<string, unknown>[] = [];
  readonly unexpected: string[] = [];
  readonly cancelled: number[] = [];
  readonly server: Deno.HttpServer<Deno.NetAddr>;
  readonly url: string;
  constructor(select?: (body: Record<string, unknown>) => Reply | undefined) {
    this.server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) => {
        const path = new URL(request.url).pathname;
        if (path === "/v1/messages/count_tokens") {
          return Response.json({
            input_tokens: 10,
          });
        }
        if (path !== "/v1/messages") {
          this.unexpected.push(path);
          return Response.json({
            error: {
              type: "not_found_error",
              message: "Unknown fixture route",
            },
          }, { status: 404 });
        }
        const body = await request.json();
        this.requests.push(body);
        const reply = select?.(body) ?? this.queue.shift();
        if (!reply) {
          this.unexpected.push("Unscripted model request");
          return Response.json({
            error: {
              type: "invalid_request_error",
              message: "Unscripted fixture request",
            },
          }, { status: 400 });
        }
        const id = `toolu_fixture_${this.requests.length}`;
        const content = reply.tool
          ? {
            type: "tool_use",
            id,
            name: reply.tool.name,
            input: reply.tool.input,
          }
          : { type: "text", text: reply.text ?? "FIXTURE_READY" };
        const message = {
          id: `msg_fixture_${this.requests.length}`,
          type: "message",
          role: "assistant",
          model: body.model,
          content: [content],
          stop_reason: reply.tool ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 4 },
        };
        if (!body.stream) return Response.json(message);
        const events = [
          {
            type: "message_start",
            message: { ...message, content: [], stop_reason: null },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: reply.tool
              ? { ...content, input: {} }
              : { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: reply.tool
              ? {
                type: "input_json_delta",
                partial_json: JSON.stringify(reply.tool.input),
              }
              : { type: "text_delta", text: reply.text ?? "FIXTURE_READY" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: {
              stop_reason: reply.tool ? "tool_use" : "end_turn",
              stop_sequence: null,
            },
            usage: { output_tokens: 4 },
          },
          { type: "message_stop" },
        ];
        const encode = (items: unknown[]) =>
          new TextEncoder().encode(
            items.map((event) =>
              `event: ${(event as { type: string }).type}\ndata: ${
                JSON.stringify(event)
              }\n\n`
            ).join(""),
          );
        let cancelled = false;
        const requestNumber = this.requests.length;
        const cancelledRequests = this.cancelled;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              if (reply.hold) controller.enqueue(encode(events.slice(0, 2)));
              void Promise.resolve(reply.hold).then(() => {
                if (cancelled) return;
                controller.enqueue(
                  encode(reply.hold ? events.slice(2) : events),
                );
                controller.close();
              });
            },
            cancel() {
              cancelled = true;
              cancelledRequests.push(requestNumber);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    );
    this.url = `http://127.0.0.1:${this.server.addr.port}`;
  }
  close() {
    return this.server.shutdown();
  }
}
