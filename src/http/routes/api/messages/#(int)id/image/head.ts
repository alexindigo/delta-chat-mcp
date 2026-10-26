// SPDX-License-Identifier: LGPL-3.0-only
// Explicitly reject HEAD rather than let a router infer GET and leak a file body.
export default () =>
  new Response(null, {
    status: 405,
    headers: { allow: "GET", "cache-control": "no-store" },
  });
