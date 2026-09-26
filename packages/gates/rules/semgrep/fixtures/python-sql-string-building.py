from sqlalchemy import text


def find_user(cursor, name):
    # ruleid: sekhemet.python-sql-string-building
    cursor.execute(f"SELECT * FROM users WHERE name = '{name}'")
    return cursor.fetchall()


def delete_cart(cursor, cart_id):
    # ruleid: sekhemet.python-sql-string-building
    cursor.execute("DELETE FROM carts WHERE id = %s" % cart_id)


def orders(db, status):
    # ruleid: sekhemet.python-sql-string-building
    query = "SELECT * FROM orders WHERE status = '" + status + "'"
    # ruleid: sekhemet.python-sql-string-building
    db.execute(text(f"UPDATE accounts SET flagged = true WHERE status = '{status}'"))
    return db.execute(query)


def safe(cursor, name, count):
    # ok: sekhemet.python-sql-string-building
    cursor.execute("SELECT * FROM users WHERE name = %s", (name,))
    # ok: sekhemet.python-sql-string-building
    message = f"Selected {count} items from the list"
    # ok: sekhemet.python-sql-string-building
    cursor.execute(text("UPDATE accounts SET flagged = true WHERE id = :id"), {"id": 1})
    return message
