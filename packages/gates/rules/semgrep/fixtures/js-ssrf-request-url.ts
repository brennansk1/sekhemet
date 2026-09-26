import https from "node:https";
import axios from "axios";
import type { Request } from "express";

export async function proxy(req: Request) {
  // ruleid: sekhemet.js-ssrf-request-url
  const page = await fetch(String(req.query.url));
  // ruleid: sekhemet.js-ssrf-request-url
  const status = await axios.get(`http://${req.body.host}/status`);
  // ruleid: sekhemet.js-ssrf-request-url
  https.get("https://" + req.params.domain + "/logo.png", (res) => res.resume());
  return { page, status };
}

export async function fixed(req: Request) {
  // ok: sekhemet.js-ssrf-request-url
  const users = await fetch("https://api.example.com/users");
  // ok: sekhemet.js-ssrf-request-url
  await axios.post(process.env.WEBHOOK_URL ?? "", { payload: req.body });
  return users;
}
