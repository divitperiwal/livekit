"""The LiveKit voice agent worker.

This module is deliberately empty of re-exports. Importing the package must
stay cheap and free of side effects: pulling ``agent`` in here would construct
an ``AgentServer`` and read the environment on any import at all, including
from a test or a tool that only wanted to price a configuration.

Import what you need from the module that owns it:

    from automitra_worker.config import AgentConfig
    from automitra_worker.agent import build_server, entrypoint
"""

__version__ = "0.1.0"

__all__ = ["__version__"]
