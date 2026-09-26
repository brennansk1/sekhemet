import json
import marshal
import pickle

import joblib
import jsonpickle


def load(request, path, blob, payload, obj):
    # ruleid: sekhemet.python-unsafe-deserialization
    data = pickle.loads(request.data)
    # ruleid: sekhemet.python-unsafe-deserialization
    model = joblib.load(path)
    # ruleid: sekhemet.python-unsafe-deserialization
    code = marshal.loads(blob)
    # ruleid: sekhemet.python-unsafe-deserialization
    state = jsonpickle.decode(payload)
    # ok: sekhemet.python-unsafe-deserialization
    raw = pickle.dumps(obj)
    # ok: sekhemet.python-unsafe-deserialization
    parsed = json.loads(request.data)
    return data, model, code, state, raw, parsed
