import yaml


def read(f, stream, text):
    # ruleid: sekhemet.python-yaml-unsafe-load
    config = yaml.load(f)
    # ruleid: sekhemet.python-yaml-unsafe-load
    docs = list(yaml.load_all(stream, Loader=yaml.Loader))
    # ruleid: sekhemet.python-yaml-unsafe-load
    data = yaml.unsafe_load(text)
    # ok: sekhemet.python-yaml-unsafe-load
    safe = yaml.safe_load(f)
    # ok: sekhemet.python-yaml-unsafe-load
    explicit = yaml.load(f, Loader=yaml.SafeLoader)
    # ok: sekhemet.python-yaml-unsafe-load
    fast = yaml.load(f, yaml.CSafeLoader)
    return config, docs, data, safe, explicit, fast
