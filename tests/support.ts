// SPDX-License-Identifier: LGPL-3.0-only

export async function deadline<T>(work: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Test deadline exceeded")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function poll(
  check: () => boolean | Promise<boolean>,
  ms = 5_000,
) {
  const until = Date.now() + ms;
  while (!await check()) {
    if (Date.now() >= until) throw new Error("Condition did not become true");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function fixture(kind: string) {
  const root = new URL(`../.test-state/${kind}/`, import.meta.url);
  await Deno.mkdir(root, { recursive: true });
  return await Deno.makeTempDir({ dir: root.pathname, prefix: "run-" });
}
