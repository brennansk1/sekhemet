import fs from "node:fs";
import path from "node:path";
import type { Request, Response } from "express";

const UPLOAD_DIR = "/srv/uploads";

export function download(req: Request, res: Response) {
  // ruleid: sekhemet.js-path-traversal-request
  const file = path.join(UPLOAD_DIR, req.params.name);
  // ruleid: sekhemet.js-path-traversal-request
  const report = fs.readFileSync(`./reports/${req.query.id}.pdf`);
  // ruleid: sekhemet.js-path-traversal-request
  fs.createReadStream(req.body.path).pipe(res);
  res.send({ file, report });
}

export function safe(req: Request, res: Response) {
  // ok: sekhemet.js-path-traversal-request
  const index = path.join(__dirname, "public", "index.html");
  // ok: sekhemet.js-path-traversal-request
  const name = path.basename(String(req.params.name));
  // ok: sekhemet.js-path-traversal-request
  res.json({ path: req.params.name, index, name });
}
