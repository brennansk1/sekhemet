import os
import subprocess


def backup(folder, host, cmd):
    # ruleid: sekhemet.python-os-system-injection
    os.system("tar czf backup.tgz " + folder)
    # ruleid: sekhemet.python-os-system-injection
    os.system(f"ping -c 1 {host}")
    # ruleid: sekhemet.python-os-system-injection
    stream = os.popen(cmd)
    return stream.read()


def safe(host):
    # ok: sekhemet.python-os-system-injection
    os.system("clear")
    # ok: sekhemet.python-os-system-injection
    subprocess.run(["ping", "-c", "1", host], check=True)
