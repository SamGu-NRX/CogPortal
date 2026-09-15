"""No-network comparison of macOS proxy lookup before/after the SDK fork."""
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy
import urllib.request
from cogbench.isolate import run_isolated


def query():
    urllib.request.proxy_bypass("example.invalid")
    return "proxy lookup returned; settings not recorded"


mode = sys.argv[1]
if mode == "direct":
    print(json.dumps({"mode": mode, "result": query()}))
elif mode == "exec":
    # Fresh interpreter; no preexec_fn, callback serialization or student code.
    result = subprocess.run([sys.executable, "-B", str(Path(__file__).resolve()), "direct"], capture_output=True, text=True)
    print(json.dumps({"mode": mode, "returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}))
else:
    if mode == "prewarm":
        query()
    result = run_isolated(query)
    print(json.dumps({"mode": mode, "status": result.status, "detail": result.detail, "value": result.value}))
