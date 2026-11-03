// SPDX-License-Identifier: LGPL-3.0-only
import { assertEquals, assertRejects } from "@std/assert";
import type { CoreMessage } from "../../src/core/client.ts";
import { resolveMessageBody } from "../../src/messaging/body.ts";
import { toMessage } from "../../src/messaging/message.ts";
import { decodePlaintextHtml } from "../../src/messaging/plaintext-html.ts";
import { FakeCore } from "./fake_core.ts";

// Literal expected HTML bodies from pinned core2.65.0 src/plaintext.rs tests.
// Footer removal/flowed joining are core's semantics, not decoder heuristics.
const html = (body: string) =>
  `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="color-scheme" content="light dark" />
</head><body dir="auto" style="unicode-bidi: plaintext">
${body}</body></html>
`;
const vectors = [
  [
    "plain",
    `line 1<br/>
line 2<br/>
line with <a href="https://link-mid-of-line.org">https://link-mid-of-line.org</a> and <a href="http://link-end-of-line.com/file?foo=bar%20">http://link-end-of-line.com/file?foo=bar%20</a><br/>
<a href="http://link-at-start-of-line.org">http://link-at-start-of-line.org</a><br/>
`,
    "line 1\nline 2\nline with https://link-mid-of-line.org and http://link-end-of-line.com/file?foo=bar%20\nhttp://link-at-start-of-line.org",
  ],
  ["signature removed by core", "Foo<br/>\nbar<br/>\n", "Foo\nbar"],
  [
    "encapsulated",
    `line with &lt;<a href="http://encapsulated.link/?foo=_bar">http://encapsulated.link/?foo=_bar</a>&gt; here!<br/>\n`,
    "line with <http://encapsulated.link/?foo=_bar> here!",
  ],
  [
    "nolink",
    "line with nohttp://no.link here<br/>\n",
    "line with nohttp://no.link here",
  ],
  [
    "mailto",
    `just an address: <a href="mailto:foo@bar.org">foo@bar.org</a> <a href="mailto:another@one.de">another@one.de</a><br/>\n`,
    "just an address: foo@bar.org another@one.de",
  ],
  [
    "flowed",
    "line still line<br/>\n<em>&gt;quote </em><br/>\n<em>&gt;still quote</em><br/>\n&gt;no quote<br/>\n",
    "line still line\n>quote \n>still quote\n>no quote",
  ],
  [
    "flowed delsp",
    "linestill line<br/>\n<em>&gt;quote </em><br/>\n<em>&gt;still quote</em><br/>\n&gt;no quote<br/>\n",
    "linestill line\n>quote \n>still quote\n>no quote",
  ],
  [
    "fixed",
    "line <br/>\nstill line<br/>\n<em>&gt;quote </em><br/>\n<em>&gt;still quote</em><br/>\n&nbsp;&gt;no quote<br/>\n",
    "line \nstill line\n>quote \n>still quote\n >no quote",
  ],
  [
    "indentation",
    "def foo():<br/>\n&nbsp;&nbsp;&nbsp;&nbsp;pass<br/>\n<br/>\ndef bar(x):<br/>\n&nbsp;&nbsp;&nbsp;&nbsp;return x + 5<br/>\n",
    "def foo():\n    pass\n\ndef bar(x):\n    return x + 5",
  ],
] as const;
for (const [name, body, expected] of vectors) {
  Deno.test(`pinned PlainText::to_html vector: ${name}`, () => {
    assertEquals(decodePlaintextHtml(html(body)), expected);
  });
}
Deno.test("pinned entities decode once, Unicode and literal markup/suffix remain content without a cap", () => {
  const line = "&quot;&amp;&#x27;&lt;&gt; &amp;lt; π 日本 😀 [...]";
  const expected = `"&'<> &lt; π 日本 😀 [...]`;
  assertEquals(
    decodePlaintextHtml(html(`${line}<br/>\n`.repeat(10000))),
    Array(10000).fill(expected).join("\n"),
  );
  assertEquals(decodePlaintextHtml(html("")), "");
  assertEquals(decodePlaintextHtml(html("flowed final ")), "flowed final ");
  assertEquals(
    decodePlaintextHtml(html("flowed&nbsp;&nbsp;indent<br/>\n")),
    "flowed  indent",
  );
  assertEquals(decodePlaintextHtml(html("line<br/>\n<br/>\n")), "line\n");
});
Deno.test("non-template and adversarial HTML is never silently stripped or normalized", () => {
  for (
    const body of [
      "<p>real HTML</p>",
      "<script>alert(1)</script>",
      "<em>not a quote</em><br/>\n",
      "<em>&gt;quote<br/>\n</em>",
      "<em>&gt;nested<em>&gt;x</em></em><br/>\n",
      '<a href="https://target">different label</a><br/>\n',
      '<a href="javascript:alert">javascript:alert</a><br/>\n',
      '<a href="mailto:foo@bar.org" onclick="x">foo@bar.org</a><br/>\n',
      '<a href="https://x">https://x</a>\n',
      "<em>&gt;body&nbsp;space</em><br/>\n",
      "&apos;<br/>\n",
      "&#39;<br/>\n",
      "&#x3c;<br/>\n",
      "&unknown;<br/>\n",
      "bare & text<br/>\n",
      "bare ' text<br/>\n",
      "raw\nnewline",
      "raw\rreturn",
      " leading<br/>\n",
    ]
  ) assertEquals(decodePlaintextHtml(html(body)), undefined, body);
  assertEquals(
    decodePlaintextHtml("<html><body>real</body></html>"),
    undefined,
  );
  assertEquals(decodePlaintextHtml(html("x<br/>\n") + "extra"), undefined);
  assertEquals(
    decodePlaintextHtml(html("x<br/>\n").replace("light dark", "dark light")),
    undefined,
  );
});

const message = (patch: Partial<CoreMessage> = {}) => ({
  id: 42,
  chatId: 99,
  fromId: 12,
  text: "display [...]",
  hasHtml: true,
  downloadState: "Done",
  sender: { displayName: "Canonical", address: "peer@example.org" },
  overrideSenderName: null,
  isInfo: false,
  isBot: false,
  isForwarded: false,
  quote: null,
  file: null,
  fileName: null,
  timestamp: 1,
  state: 10,
  showPadlock: true,
  ...patch,
} as CoreMessage);

Deno.test("body contract distinguishes complete text, retained HTML, null and partial downloads", async () => {
  let returned: string | null = html("full<br/>\ntext<br/>\n");
  const core = new FakeCore({
    getMessageHtml: () => Promise.resolve(returned),
  });
  const resolve = (patch: Partial<CoreMessage> = {}) =>
    core.use((rpc) => resolveMessageBody(rpc, 7, message(patch)));
  assertEquals(await resolve(), { text: "full\ntext", textComplete: true });
  returned = "<p>HTML original &amp; complete</p>";
  assertEquals(await resolve(), {
    text: "display [...]",
    textComplete: false,
    html: returned,
  });
  returned = null;
  assertEquals(await resolve(), { text: "display [...]", textComplete: false });
  const before = core.calls.length;
  assertEquals(await resolve({ hasHtml: false, text: "literal [...]" }), {
    text: "literal [...]",
    textComplete: true,
  });
  for (
    const downloadState of [
      "Available",
      "InProgress",
      "Failure",
      "Undecipherable",
    ] as const
  ) {
    assertEquals(await resolve({ hasHtml: false, downloadState }), {
      text: "display [...]",
      textComplete: false,
    });
  }
  assertEquals(core.calls.length, before);
  returned = html("full<br/>\n");
  assertEquals(await resolve({ downloadState: "Available" }), {
    text: "display [...]",
    textComplete: false,
    html: returned,
  });
  core.handlers.getMessageHtml = () =>
    Promise.reject(new Error("existing body load failed"));
  await assertRejects(() => resolve(), Error, "existing body load failed");
});
Deno.test("canonical sender, forwarded, info, bot and quote facts map without inventing provenance", () => {
  const body = { text: "full", textComplete: true };
  const mapped = toMessage(
    message({
      overrideSenderName: "Alias",
      isInfo: true,
      isBot: true,
      isForwarded: true,
      quote: {
        kind: "WithMessage",
        text: "quoted",
        messageId: 123,
        authorDisplayName: "Author",
        overrideSenderName: "Author alias",
      } as CoreMessage["quote"],
    }),
    body,
  );
  assertEquals([
    mapped.fromName,
    mapped.fromAddress,
    mapped.isInfo,
    mapped.isBot,
    mapped.isForwarded,
  ], ["Alias", "peer@example.org", true, true, true]);
  assertEquals(mapped.quote, {
    text: "quoted",
    messageId: 123,
    authorName: "Author alias",
  });
  assertEquals(
    toMessage(
      message({ quote: { kind: "JustText", text: "unknown original" } }),
      body,
    ).quote,
    { text: "unknown original" },
  );
  const linked = message({
    quote: {
      kind: "WithMessage",
      text: "q",
      messageId: 456,
      authorDisplayName: "Author",
      overrideSenderName: null,
    } as CoreMessage["quote"],
  });
  assertEquals(toMessage(linked, body).quote, {
    text: "q",
    messageId: 456,
    authorName: "Author",
  });
  assertEquals(toMessage(message(), body).fromName, "Canonical");
  assertEquals(toMessage(message(), body).quote, undefined);
});
