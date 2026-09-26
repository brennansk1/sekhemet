import getpass
import os

import psycopg2

# ruleid: sekhemet.python-hardcoded-password
DB_PASSWORD = "Sup3rS3cret!2024"
# ruleid: sekhemet.python-hardcoded-password
SECRET_KEY = "django-insecure-8f2k1l0x9q"
# ok: sekhemet.python-hardcoded-password
API_KEY = os.environ["API_KEY"]
# ok: sekhemet.python-hardcoded-password
PASSWORD_FIELD = "password"


def connect():
    # ruleid: sekhemet.python-hardcoded-password
    return psycopg2.connect(host="db", user="app", password="hunter2hunter2")


def ask():
    # ok: sekhemet.python-hardcoded-password
    password = getpass.getpass("Password: ")
    # ok: sekhemet.python-hardcoded-password
    settings = {"api_key": "", "secret": "<set me>"}
    return password, settings
