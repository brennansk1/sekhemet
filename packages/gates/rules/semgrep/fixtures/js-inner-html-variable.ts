declare const DOMPurify: { sanitize(s: string): string };

export function render(el: HTMLElement, comment: { body: string }, name: string) {
  // ruleid: sekhemet.js-inner-html-variable
  el.innerHTML = comment.body;
  // ruleid: sekhemet.js-inner-html-variable
  el.innerHTML += `<li>${name}</li>`;
  // ruleid: sekhemet.js-inner-html-variable
  el.insertAdjacentHTML("beforeend", "<p>" + name + "</p>");
  // ruleid: sekhemet.js-inner-html-variable
  document.write(comment.body);
  // ok: sekhemet.js-inner-html-variable
  el.innerHTML = "";
  // ok: sekhemet.js-inner-html-variable
  el.innerHTML = DOMPurify.sanitize(comment.body);
  // ok: sekhemet.js-inner-html-variable
  el.textContent = comment.body;
  // ok: sekhemet.js-inner-html-variable
  el.insertAdjacentHTML("beforeend", "<hr />");
}
