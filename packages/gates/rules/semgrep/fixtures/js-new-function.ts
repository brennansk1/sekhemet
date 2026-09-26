export function compile(body: string) {
  // ruleid: sekhemet.js-new-function
  const fn = new Function("a", "b", body);
  return fn;
}

export function runTemplate(code: string, data: unknown) {
  // ruleid: sekhemet.js-new-function
  return new Function("data", `return (${code});`)(data);
}

export function safe(expr: Expr) {
  // ok: sekhemet.js-new-function
  const double = (a: number) => a * 2;
  // ok: sekhemet.js-new-function
  const call = new FunctionCall(expr);
  // ok: sekhemet.js-new-function
  const isFn = typeof expr === "function" && expr instanceof Function;
  return { double, call, isFn };
}
