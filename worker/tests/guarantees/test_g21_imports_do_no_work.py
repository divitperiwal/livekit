import subprocess
import sys

IMPORT_EVERY_MODULE_WITH_NETWORK_BLOCKED = """
import importlib
import pkgutil
import socket

def refuse_connection(*args, **kwargs):
    raise SystemExit("a worker module opened a network connection on import")

socket.socket.connect = refuse_connection
socket.create_connection = refuse_connection

import automitra_worker

for module in pkgutil.walk_packages(automitra_worker.__path__, prefix="automitra_worker."):
    importlib.import_module(module.name)
"""


def test_importing_every_worker_module_opens_no_network_connection():
    result = subprocess.run(
        [sys.executable, "-c", IMPORT_EVERY_MODULE_WITH_NETWORK_BLOCKED],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
