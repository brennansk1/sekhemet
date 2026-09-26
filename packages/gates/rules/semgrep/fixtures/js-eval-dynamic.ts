export function calculate(userInput: string) {
  // ruleid: sekhemet.js-eval-dynamic
  const result = eval(userInput);
  return result;
}

export function parseLegacy(body: string) {
  // ruleid: sekhemet.js-eval-dynamic
  return eval("(" + body + ")");
}

export function run(page: Page, script: string, expr: string) {
  // ok: sekhemet.js-eval-dynamic
  page.eval(script);
  // ok: sekhemet.js-eval-dynamic
  const value = evaluate(expr);
  // ok: sekhemet.js-eval-dynamic
  const four = eval("2 + 2");
  return [value, four];
}
