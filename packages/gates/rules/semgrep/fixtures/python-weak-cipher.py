from Crypto.Cipher import AES, DES
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def encrypt(key, iv, nonce):
    # ruleid: sekhemet.python-weak-cipher
    a = DES.new(key, DES.MODE_CBC, iv)
    # ruleid: sekhemet.python-weak-cipher
    b = AES.new(key, AES.MODE_ECB)
    # ruleid: sekhemet.python-weak-cipher
    c = Cipher(algorithms.ARC4(key), mode=None)
    # ruleid: sekhemet.python-weak-cipher
    d = Cipher(algorithms.AES(key), modes.ECB())
    # ok: sekhemet.python-weak-cipher
    e = AES.new(key, AES.MODE_GCM, nonce=nonce)
    # ok: sekhemet.python-weak-cipher
    f = Cipher(algorithms.AES(key), modes.GCM(iv))
    return a, b, c, d, e, f
