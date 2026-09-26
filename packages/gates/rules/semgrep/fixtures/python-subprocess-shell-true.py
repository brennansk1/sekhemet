import subprocess


def convert(src, dst, cmd, path):
    # ruleid: sekhemet.python-subprocess-shell-true
    subprocess.run(f"convert {src} {dst}", shell=True, check=True)
    # ruleid: sekhemet.python-subprocess-shell-true
    out = subprocess.check_output(cmd, shell=True, text=True)
    # ruleid: sekhemet.python-subprocess-shell-true
    listing = subprocess.getoutput("ls -la " + path)
    return out, listing


def safe(src, dst, cmd):
    # ok: sekhemet.python-subprocess-shell-true
    subprocess.run(["convert", src, dst], check=True)
    # ok: sekhemet.python-subprocess-shell-true
    subprocess.run("make clean", shell=True)
    # ok: sekhemet.python-subprocess-shell-true
    subprocess.call(cmd, shell=False)
