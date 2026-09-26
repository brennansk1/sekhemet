import ssl

import requests


def fetch(url, session):
    # ruleid: sekhemet.python-tls-verification-disabled
    r = requests.get(url, verify=False, timeout=10)
    # ruleid: sekhemet.python-tls-verification-disabled
    ctx = ssl._create_unverified_context()
    # ruleid: sekhemet.python-tls-verification-disabled
    ctx.verify_mode = ssl.CERT_NONE
    # ruleid: sekhemet.python-tls-verification-disabled
    session.verify = False
    # ok: sekhemet.python-tls-verification-disabled
    ok = requests.get(url, timeout=10)
    # ok: sekhemet.python-tls-verification-disabled
    pinned = requests.get(url, verify="/etc/ssl/certs/internal-ca.pem", timeout=10)
    # ok: sekhemet.python-tls-verification-disabled
    ctx.verify_mode = ssl.CERT_REQUIRED
    return r, ok, pinned
