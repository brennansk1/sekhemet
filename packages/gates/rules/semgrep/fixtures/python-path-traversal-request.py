import os

from flask import request, send_file, send_from_directory
from werkzeug.utils import secure_filename

REPORTS = "/srv/reports"
UPLOADS = "/srv/uploads"


def report():
    # ruleid: sekhemet.python-path-traversal-request
    with open(os.path.join(REPORTS, request.args["name"])) as f:
        return f.read()


def download():
    # ruleid: sekhemet.python-path-traversal-request
    return send_file(request.args.get("path"))


def remove():
    # ruleid: sekhemet.python-path-traversal-request
    os.remove(request.form["file"])


def safe():
    # ok: sekhemet.python-path-traversal-request
    page = send_from_directory(REPORTS, request.args["name"])
    # ok: sekhemet.python-path-traversal-request
    path = os.path.join(UPLOADS, secure_filename(request.files["doc"].filename))
    # ok: sekhemet.python-path-traversal-request
    with open("settings.json") as f:
        return page, path, f.read()
