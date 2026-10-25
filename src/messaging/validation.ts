// SPDX-License-Identifier: LGPL-3.0-only
export function requireId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new Error("Invalid core ID");
  }
  return value;
}
export function requireIds(values: readonly number[]): number[] {
  return [...new Set(values.map(requireId))];
}
