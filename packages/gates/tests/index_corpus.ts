/** A module exercising every export and import form the index reads (T2). */
export const EXPORT_CORPUS = `import { a, type B } from "./a.js";
import * as ns from "./ns.js";
import def, { c as d } from "pkg";
export { a as reA } from "./a.js";
export type { B };
export function f() { return ns.x + def + d; }
export default function g() {}
export async function h() {}
export abstract class K { m() { return 1; } }
export interface I { p: string; q(): void }
export type T = { a: number };
export const arrow = (x: number) => { return x; };
export declare const decl: string;
const local = 1;
function inner() { function nested() {} }
export { local, inner as renamed };
// export const commented = 1;
const s = "export const inString = 1";
`;
