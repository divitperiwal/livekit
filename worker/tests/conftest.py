import sys
from pathlib import Path

import pytest
from aiohttp.test_utils import TestServer

# Lets tests import shared fakes (`from cost_fakes import ...`).
sys.path.insert(0, str(Path(__file__).parent))

from fake_bucket import FakeBucket  # noqa: E402
from fake_control_plane import FakeControlPlane  # noqa: E402


@pytest.fixture
async def fake_bucket():
    bucket = FakeBucket()
    server = TestServer(bucket.app)
    await server.start_server()
    bucket.endpoint = str(server.make_url("")).rstrip("/")
    yield bucket
    await server.close()


@pytest.fixture
async def fake_api():
    api = FakeControlPlane()
    server = TestServer(api.app)
    await server.start_server()
    api.url = str(server.make_url("")).rstrip("/")
    yield api
    await server.close()
