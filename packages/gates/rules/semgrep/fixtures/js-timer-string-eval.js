export function schedule(id, handlerName, socket) {
  // ruleid: sekhemet.js-timer-string-eval
  setTimeout("refresh()", 1000);
  // ruleid: sekhemet.js-timer-string-eval
  setInterval(`poll(${id})`, 500);
  // ruleid: sekhemet.js-timer-string-eval
  window.setTimeout(handlerName + "()", 250);
  // ok: sekhemet.js-timer-string-eval
  setTimeout(() => refresh(), 1000);
  // ok: sekhemet.js-timer-string-eval
  setInterval(poll, 500, id);
  // ok: sekhemet.js-timer-string-eval
  socket.setTimeout(30_000);
}
