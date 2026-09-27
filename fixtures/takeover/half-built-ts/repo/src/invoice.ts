export interface Line {
  price: number;
  qty: number;
}

export function invoiceTotal(lines: Line[]): number {
  return lines.reduce((sum, l) => sum + l.price * l.qty, 0);
}
