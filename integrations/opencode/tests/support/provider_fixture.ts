// SPDX-License-Identifier: LGPL-3.0-only
// Wire shape: OpenCode reference test/lib/llm-server.ts:55–129,418–430.
// Provider config: test/lib/test-provider.ts:9–36. No upstream test runtime import.
export interface Reply {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
  hold?: Promise<void>;
  holdSilent?: boolean;
  usage?: number;
  status?: number;
  chunks?: number;
}

export class ProviderFixture {
  readonly requests: Record<string, unknown>[] = [];
  readonly unexpected: string[] = [];
  readonly queue: Reply[] = [];
  readonly #abort = new AbortController();
  readonly #http: Deno.HttpServer<Deno.NetAddr>;
  readonly url: string;

  constructor() {
    this.#http = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      signal: this.#abort.signal,
      onListen() {},
    }, async (request) => {
      if (new URL(request.url).pathname !== "/v1/chat/completions") {
        this.unexpected.push(request.url);
        return new Response("Unexpected fixture route", { status: 400 });
      }
      const body = await request.json();
      this.requests.push(body);
      const reply = this.queue.shift();
      if (!reply) {
        this.unexpected.push("Unscripted provider request");
        return new Response("Unscripted provider request", { status: 400 });
      }
      if (reply.status) {
        return Response.json({ error: { message: "fixture rejection" } }, {
          status: reply.status,
        });
      }
      const encoder = new TextEncoder();
      const chunk = (delta: unknown, finish?: string) => ({
        id: `chatcmpl-fixture-${this.requests.length}`,
        object: "chat.completion.chunk",
        choices: [{
          index: 0,
          delta,
          ...(finish && { finish_reason: finish }),
        }],
        ...(finish && {
          usage: {
            prompt_tokens: reply.usage ?? 10,
            completion_tokens: 4,
            total_tokens: (reply.usage ?? 10) + 4,
          },
        }),
      });
      let cancelled = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (value: unknown) => {
              if (!cancelled) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
                );
              }
            };
            send(chunk({ role: "assistant" }));
            if (reply.hold && !reply.holdSilent) {
              send(chunk({ content: "fixture-stream-held" }));
            }
            void (async () => {
              if (reply.hold) await reply.hold;
              if (cancelled) return;
              if (reply.tool) {
                send(chunk({
                  tool_calls: [{
                    index: 0,
                    id: "call_fixture",
                    type: "function",
                    function: { name: reply.tool.name, arguments: "" },
                  }],
                }));
                send(chunk({
                  tool_calls: [{
                    index: 0,
                    function: { arguments: JSON.stringify(reply.tool.args) },
                  }],
                }));
              } else if (reply.chunks) {
                for (let i = 0; i < reply.chunks; i++) {
                  send(
                    chunk({
                      content: `${reply.text ?? "fixture-answer"}-${i}\n`,
                    }),
                  );
                }
              } else send(chunk({ content: reply.text ?? "fixture-answer" }));
              send(chunk({}, reply.tool ? "tool_calls" : "stop"));
              if (!cancelled) {
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                controller.close();
              }
            })().catch((error) => {
              if (!cancelled) controller.error(error);
            });
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    });
    this.url = `http://127.0.0.1:${this.#http.addr.port}/v1`;
  }

  config(context = 100_000) {
    return {
      formatter: false,
      lsp: false,
      snapshot: false,
      share: "disabled",
      autoupdate: false,
      model: "test/test-model",
      small_model: "test/test-model",
      enabled_providers: ["test"],
      permission: { "*": "allow" },
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              attachment: false,
              reasoning: false,
              temperature: false,
              tool_call: true,
              release_date: "2025-01-01",
              limit: { context, output: Math.min(1000, context / 4) },
              cost: { input: 0, output: 0 },
              options: {},
              variants: { careful: { temperature: 0 } },
            },
          },
          options: { apiKey: "fixture-only", baseURL: this.url },
        },
      },
    };
  }

  async close() {
    this.#abort.abort();
    await this.#http.finished;
  }
}
