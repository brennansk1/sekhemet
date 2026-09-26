import ast


def calc(request, a, op, b):
    # ruleid: sekhemet.python-eval-exec
    result = eval(request.args.get("expr"))
    # ruleid: sekhemet.python-eval-exec
    total = eval(f"{a} {op} {b}")
    return result, total


def plugin(compiled_source, namespace):
    # ruleid: sekhemet.python-eval-exec
    exec(compiled_source, namespace)


def safe(model, text, db, query):
    # ok: sekhemet.python-eval-exec
    model.eval()
    # ok: sekhemet.python-eval-exec
    value = ast.literal_eval(text)
    # ok: sekhemet.python-eval-exec
    db.exec(query)
    # ok: sekhemet.python-eval-exec
    two = eval("1 + 1")
    return value, two
