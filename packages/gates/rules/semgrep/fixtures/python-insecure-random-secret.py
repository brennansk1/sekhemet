import random
import secrets
import string


def issue(items):
    # ruleid: sekhemet.python-insecure-random-secret
    token = "".join(random.choice(string.ascii_letters) for _ in range(32))
    # ruleid: sekhemet.python-insecure-random-secret
    reset_token = str(random.getrandbits(64))
    # ruleid: sekhemet.python-insecure-random-secret
    API_KEY = "%032x" % random.getrandbits(128)
    # ok: sekhemet.python-insecure-random-secret
    session_token = secrets.token_urlsafe(32)
    # ok: sekhemet.python-insecure-random-secret
    delay = random.uniform(0.5, 1.5)
    # ok: sekhemet.python-insecure-random-secret
    picks = random.sample(items, 3)
    return token, reset_token, API_KEY, session_token, delay, picks
