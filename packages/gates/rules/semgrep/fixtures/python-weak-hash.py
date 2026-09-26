import hashlib


def fingerprint(password, token, data, body):
    # ruleid: sekhemet.python-weak-hash
    digest = hashlib.md5(password.encode()).hexdigest()
    # ruleid: sekhemet.python-weak-hash
    check = hashlib.sha1(token).hexdigest()
    # ruleid: sekhemet.python-weak-hash
    legacy = hashlib.new("md5", data)
    # ok: sekhemet.python-weak-hash
    etag = hashlib.md5(body.encode(), usedforsecurity=False).hexdigest()
    # ok: sekhemet.python-weak-hash
    strong = hashlib.sha256(data).hexdigest()
    return digest, check, legacy, etag, strong
