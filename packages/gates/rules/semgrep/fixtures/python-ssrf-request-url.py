from urllib.request import urlopen

import httpx
import requests
from flask import request

API_URL = "https://api.example.com/v1/search"


def proxy():
    # ruleid: sekhemet.python-ssrf-request-url
    page = requests.get(request.args["url"], timeout=5)
    # ruleid: sekhemet.python-ssrf-request-url
    health = httpx.get(f"http://{request.args.get('host')}/health")
    # ruleid: sekhemet.python-ssrf-request-url
    feed = urlopen(request.form["feed"]).read()
    return page, health, feed


def fixed():
    # ok: sekhemet.python-ssrf-request-url
    status = requests.get("https://api.example.com/v1/status", timeout=5)
    # ok: sekhemet.python-ssrf-request-url
    results = requests.get(API_URL, params=request.args, timeout=5)
    return status, results
