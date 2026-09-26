import jwt


def claims(token, key):
    # ruleid: sekhemet.python-jwt-verification-disabled
    a = jwt.decode(token, options={"verify_signature": False})
    # ruleid: sekhemet.python-jwt-verification-disabled
    b = jwt.decode(token, key, verify=False)
    # ruleid: sekhemet.python-jwt-verification-disabled
    c = jwt.decode(token, key, algorithms=["HS256", "none"])
    # ok: sekhemet.python-jwt-verification-disabled
    d = jwt.decode(token, key, algorithms=["RS256"])
    # ok: sekhemet.python-jwt-verification-disabled
    e = jwt.decode(token, key, algorithms=["HS256"], options={"verify_exp": True})
    return a, b, c, d, e
