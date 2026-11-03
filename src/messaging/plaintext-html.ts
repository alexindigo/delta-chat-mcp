// SPDX-License-Identifier: LGPL-3.0-only
/** Pinned chatmail/core v2.65.0 src/plaintext.rs PlainText::to_html.
 * Cargo.lock pins escaper 0.1.1; src/{lib,encode}.rs emits exactly these five
 * entities. This is a recognizer for that serialization, not an HTML renderer.
 * Unknown/ambiguous markup stays HTML. Core removes footers, CRs and joins
 * format=flowed lines before emitting this representation.
 */
const header = `<!DOCTYPE html>
<html><head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
<meta name="color-scheme" content="light dark" />
</head><body dir="auto" style="unicode-bidi: plaintext">
`;
const footer = "</body></html>\n";
const entities: Record<string, string> = {
  "&quot;": '"',
  "&amp;": "&",
  "&#x27;": "'",
  "&lt;": "<",
  "&gt;": ">",
};
// Rust regex \w = Alphabetic + Mark + Decimal_Number + Connector_Punctuation
// + Join_Control. URL/mail characters are from the pinned linkifier, not a URL
// parser (which would normalize or accept a different language).
const word = "\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d";
const url = new RegExp(
  `^(?:http|https|ftp|ftps):[${word}.,:;$/@!?&%\\-~=#+]+$`,
  "u",
);
const mail = new RegExp(`^[${word}.\\-+]+@[${word}.\\-]+$`, "u");

function unescape(value: string): string | undefined {
  // Raw quotes, angle brackets and CR/LF cannot be emitted by encode_minimal.
  if (/[<>"'\r\n]/u.test(value)) return undefined;
  let valid = true;
  const text = value.replace(/&[^;]*;|&/gu, (entity) => {
    if (!(entity in entities)) valid = false;
    return entities[entity] ?? "";
  });
  return valid ? text : undefined;
}

export function decodePlaintextHtml(html: string): string | undefined {
  if (!html.startsWith(header) || !html.endsWith(footer)) return undefined;
  const body = html.slice(header.length, -footer.length);
  const chunks: string[] = [];
  let pos = 0, quoted = false, quoteStart = false, lineStart = true;
  while (pos < body.length) {
    if (body.startsWith("<br/>\n", pos)) {
      if (quoted) return undefined;
      chunks.push("\n");
      pos += 6;
      lineStart = true;
    } else if (body.startsWith("<em>", pos)) {
      if (quoted || !body.startsWith("&gt;", pos + 4)) return undefined;
      quoted = true;
      quoteStart = true;
      pos += 4;
    } else if (body.startsWith("</em><br/>\n", pos)) {
      if (!quoted || quoteStart) return undefined;
      quoted = false;
      pos += 5;
    } else if (body.startsWith("&nbsp;", pos)) {
      // Indentation is emitted per source line, including joined flowed
      // fragments in the middle of a logical line. Quoted lines start with
      // <em>, so trim_start_matches(' ') can never emit NBSP inside them.
      if (quoted) return undefined;
      chunks.push(" ");
      pos += 6;
    } else if (body.startsWith('<a href="', pos)) {
      const end = body.indexOf("</a>", pos + 9);
      if (end === -1) return undefined;
      const anchor = body.slice(pos, end + 4);
      const match = /^<a href="([^<>"\r\n]*)">([^<>\r\n]*)<\/a>$/u.exec(anchor);
      if (!match) return undefined;
      const target = unescape(match[1]), label = unescape(match[2]);
      if (target === undefined || label === undefined) return undefined;
      if (
        !((target === label && url.test(label)) ||
          (target === `mailto:${label}` && mail.test(label)))
      ) return undefined;
      chunks.push(label);
      pos = end + 4;
      lineStart = false;
      quoteStart = false;
    } else {
      const match = /^(?:&(?:quot|amp|#x27|lt|gt);|[^&<>"'\r\n])+/u.exec(
        body.slice(pos),
      );
      if (!match) return undefined;
      const text = unescape(match[0]);
      if (text === undefined || (lineStart && text.startsWith(" "))) {
        return undefined;
      }
      chunks.push(text);
      pos += match[0].length;
      lineStart = false;
      quoteStart = false;
    }
  }
  if (quoted) return undefined;
  const text = chunks.join("");
  // to_html appends a break for the last fixed line as well. It cannot preserve
  // whether the original source had a terminal LF; expose core's logical lines.
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}
