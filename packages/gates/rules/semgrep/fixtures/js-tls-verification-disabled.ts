import https from "node:https";

export function agents(url: string, ca: string) {
  // ruleid: sekhemet.js-tls-verification-disabled
  const insecure = new https.Agent({ rejectUnauthorized: false });
  // ruleid: sekhemet.js-tls-verification-disabled
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  // ruleid: sekhemet.js-tls-verification-disabled
  request({ url, strictSSL: false });
  // ok: sekhemet.js-tls-verification-disabled
  const pinned = new https.Agent({ rejectUnauthorized: true, ca });
  // ok: sekhemet.js-tls-verification-disabled
  const strict = process.env.NODE_TLS_REJECT_UNAUTHORIZED === "1";
  return { insecure, pinned, strict };
}
