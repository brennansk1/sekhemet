import type { Request, Response } from "express";

declare function safeReturnPath(p: unknown): string;

export function afterLogin(req: Request, res: Response) {
  if (req.query.returnTo) {
    // ruleid: sekhemet.js-open-redirect
    return res.redirect(req.query.returnTo as string);
  }
  // ruleid: sekhemet.js-open-redirect
  return res.redirect(302, req.body.next);
}

export function safe(req: Request, res: Response) {
  if (req.query.returnTo) {
    // ok: sekhemet.js-open-redirect
    return res.redirect(safeReturnPath(req.query.returnTo));
  }
  // ok: sekhemet.js-open-redirect
  return res.redirect("/login");
}
