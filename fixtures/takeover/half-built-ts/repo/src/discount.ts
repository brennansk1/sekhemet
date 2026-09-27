export function applyDiscount(total: number, code: string): number {
  // The codes table was never wired: every code is ignored.
  return code ? total : total;
}
