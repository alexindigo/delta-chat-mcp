// SPDX-License-Identifier: LGPL-3.0-only
export default () =>
  Response.json({ error: "Method not allowed" }, { status: 405 });
