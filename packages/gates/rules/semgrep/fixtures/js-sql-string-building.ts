import type { Request } from "express";
import { db, knex, sql } from "./db";

export async function findUser(name: string) {
  // ruleid: sekhemet.js-sql-string-building
  const rows = await db.query(`SELECT * FROM users WHERE name = '${name}'`);
  return rows;
}

export async function findOrder(req: Request) {
  // ruleid: sekhemet.js-sql-string-building
  const text = "SELECT id, total FROM orders WHERE id = '" + req.params.id + "'";
  return db.query(text);
}

export async function emptyCart(userId: string) {
  // ruleid: sekhemet.js-sql-string-building
  await knex.raw("DELETE FROM carts WHERE user_id = " + userId);
}

export async function report(table: string, since: string) {
  // ruleid: sekhemet.js-sql-string-building
  const q = `
    SELECT count(*)
    FROM ${table}
    WHERE created_at > '${since}'`;
  return db.query(q);
}

export async function findUserSafely(id: string) {
  // ok: sekhemet.js-sql-string-building
  const rows = await db.query("SELECT * FROM users WHERE id = $1", [id]);
  // ok: sekhemet.js-sql-string-building
  const tagged = await sql`SELECT * FROM users WHERE id = ${id}`;
  // ok: sekhemet.js-sql-string-building
  const stmt = db.prepare("DELETE FROM sessions WHERE expires_at < ?");
  // ok: sekhemet.js-sql-string-building
  const message = `Updated ${rows.length} rows for ${id}`;
  return { rows, tagged, stmt, message };
}
