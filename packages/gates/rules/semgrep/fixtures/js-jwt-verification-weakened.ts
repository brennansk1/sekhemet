import jwt from "jsonwebtoken";

export function check(token: string, key: string, claims: object) {
  // ruleid: sekhemet.js-jwt-verification-weakened
  const a = jwt.verify(token, key, { algorithms: ["none", "HS256"] });
  // ruleid: sekhemet.js-jwt-verification-weakened
  const unsigned = jwt.sign(claims, "", { algorithm: "none" });
  // ruleid: sekhemet.js-jwt-verification-weakened
  const b = jwt.verify(token, key, { ignoreExpiration: true });
  // ok: sekhemet.js-jwt-verification-weakened
  const c = jwt.verify(token, key, { algorithms: ["RS256"] });
  // ok: sekhemet.js-jwt-verification-weakened
  const d = jwt.verify(token, key, { ignoreExpiration: false });
  return [a, unsigned, b, c, d];
}
