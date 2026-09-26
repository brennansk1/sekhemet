import { readFileSync } from "node:fs";

// ruleid: sekhemet.hardcoded-private-key
const signingKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIBfake\n-----END RSA PRIVATE KEY-----";
// ruleid: sekhemet.hardcoded-private-key
const deployKey = `-----BEGIN OPENSSH PRIVATE KEY-----
not-a-real-key
-----END OPENSSH PRIVATE KEY-----`;
// ruleid: sekhemet.hardcoded-private-key
const generic = "-----BEGIN PRIVATE KEY-----";
// ok: sekhemet.hardcoded-private-key
const publicKey = "-----BEGIN PUBLIC KEY-----\nMFkwfake\n-----END PUBLIC KEY-----";
// ok: sekhemet.hardcoded-private-key
const certificate = "-----BEGIN CERTIFICATE-----";
// ok: sekhemet.hardcoded-private-key
const privateKey = readFileSync(process.env.KEY_PATH ?? "key.pem", "utf8");

export { signingKey, deployKey, generic, publicKey, certificate, privateKey };
