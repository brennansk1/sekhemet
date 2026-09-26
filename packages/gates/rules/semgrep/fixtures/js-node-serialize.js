// ruleid: sekhemet.js-node-serialize
import serialize from "node-serialize";
// ok: sekhemet.js-node-serialize
import serializeJs from "serialize-javascript";

export function loadProfile(req) {
  // ruleid: sekhemet.js-node-serialize
  const profile = serialize.unserialize(req.cookies.profile);
  // ok: sekhemet.js-node-serialize
  const prefs = JSON.parse(req.cookies.prefs);
  return { profile, prefs, page: serializeJs(prefs) };
}

export function legacy() {
  // ruleid: sekhemet.js-node-serialize
  const s = require("serialize-to-js");
  return s;
}
