// SPDX-License-Identifier: LGPL-3.0-only
import { extname, fromFileUrl, join, relative } from "@std/path";
const dist = fromFileUrl(new URL("../../web/dist/", import.meta.url));
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
const missing = () => Response.json({ error: "Not found" }, { status: 404 });

/** Static-only fallback: reserved namespaces can never become SPA documents. */
export async function staticResponse(
  request: Request,
  root = dist,
): Promise<Response> {
  let path: string;
  try {
    path = decodeURIComponent(new URL(request.url).pathname);
  } catch {
    return missing();
  }
  const segments = path.split("/").filter(Boolean);
  if (
    segments.some((part) =>
      part === ".." || part === "." || part.includes("\\") ||
      part.includes("\0")
    ) || ["api", "mcp", "_", "_status"].includes(segments[0])
  ) return missing();
  const file = segments.length ? segments.join("/") : "index.html";
  const candidate = join(root, file);
  try {
    const realRoot = await Deno.realPath(root),
      real = await Deno.realPath(candidate);
    if (
      relative(realRoot, real).startsWith("..") ||
      !(await Deno.stat(real)).isFile
    ) return missing();
    const extension = extname(real);
    if (!mime[extension]) return missing();
    return new Response(await Deno.readFile(real), {
      headers: {
        "content-type": mime[extension],
        "x-content-type-options": "nosniff",
        "cache-control": extension === ".html"
          ? "no-store"
          : "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    if (extname(file) || file.startsWith("assets/")) return missing();
    try {
      return new Response(await Deno.readFile(join(root, "index.html")), {
        headers: {
          "content-type": mime[".html"],
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (fallback) {
      if (fallback instanceof Deno.errors.NotFound) return missing();
      throw fallback;
    }
  }
}
