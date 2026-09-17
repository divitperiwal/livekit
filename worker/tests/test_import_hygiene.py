"""Guards against imports that do work.

Importing a module should not read the environment, construct a worker, or
touch the network. That property is easy to lose -- a single convenience
re-export in ``__init__.py`` is enough -- and the consequences show up far from
the cause: a tool that only wanted to price a configuration fails at startup
because a telephony variable is malformed.

Each test runs in a subprocess, because an import in this process would already
have happened by the time the assertion ran.
"""

from __future__ import annotations

import subprocess
import sys


def run_python(code: str, **env: str) -> subprocess.CompletedProcess[str]:
    """Run a snippet in a clean interpreter, returning the completed process."""
    import os

    environment = {**os.environ, **env}
    return subprocess.run(
        [sys.executable, "-c", code],
        capture_output=True,
        text=True,
        env=environment,
    )


def test_importing_the_package_does_not_load_the_agents_runtime() -> None:
    """The package root must stay cheap to import.

    ``livekit.agents`` pulls in the inference stack. Anything that imports this
    package for a type or a constant should not pay for that.
    """
    result = run_python(
        "import automitra_worker, sys;"
        "assert 'livekit.agents' not in sys.modules, "
        "'importing the package pulled in livekit.agents'"
    )
    assert result.returncode == 0, result.stderr


def test_importing_the_package_does_not_construct_a_server() -> None:
    result = run_python(
        "import automitra_worker, sys;"
        "assert 'automitra_worker.agent' not in sys.modules, "
        "'importing the package pulled in the agent module'"
    )
    assert result.returncode == 0, result.stderr


def test_importing_the_agent_module_does_not_read_the_environment() -> None:
    """A malformed telephony variable must not break an import.

    This is the regression that motivated the change: ``TelephonyConfig.from_env()``
    at module scope meant an unparseable PLIVO_SIP_ZONE raised on import, so no
    process could import the module to do anything else.
    """
    result = run_python(
        "import automitra_worker.agent",
        TELEPHONY_ENABLED="true",
        PLIVO_SIP_ZONE="nonsense-zone",
    )
    assert result.returncode == 0, (
        "importing the agent module read the environment and failed:\n"
        + result.stderr
    )


def test_importing_the_cli_modules_does_not_read_the_environment() -> None:
    result = run_python(
        "import automitra_worker.cli, automitra_worker.telephony_cli",
        TELEPHONY_ENABLED="true",
        PLIVO_SIP_ZONE="nonsense-zone",
    )
    assert result.returncode == 0, result.stderr


def test_config_import_pulls_in_the_voice_stack() -> None:
    """Documents a coupling we do not control, because it shapes the design.

    ``config`` validates models against the Sarvam plugin's own type aliases,
    which is the right source of truth -- it cannot drift from the installed
    version. The cost is that importing the plugin imports ``livekit.agents``,
    so this validation cannot be lifted into a library the control plane
    installs without dragging the whole voice stack with it.

    That is why the control plane validates against a JSON Schema generated
    from this module rather than importing it. If this test ever fails because
    the coupling has gone, that decision is worth revisiting.
    """
    result = run_python(
        "import automitra_worker.config, sys;"
        "print('livekit.agents' in sys.modules)"
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "True", (
        "the Sarvam plugin no longer pulls in livekit.agents -- config "
        "validation could now be shared directly with the control plane"
    )


def test_pure_modules_stay_free_of_the_voice_stack() -> None:
    """Cost and budget are arithmetic and must stay importable on their own.

    These are the modules the control plane will reuse for metering, so the
    coupling above must not spread to them.
    """
    result = run_python(
        "import automitra_worker.costs, automitra_worker.budget, sys;"
        "assert 'livekit.agents' not in sys.modules, "
        "'costs/budget picked up a dependency on the voice stack'"
    )
    assert result.returncode == 0, result.stderr


def test_build_server_is_what_actually_registers_the_worker() -> None:
    """The side effects still have to happen -- just when asked for, not on import."""
    result = run_python(
        "from automitra_worker.agent import build_server;"
        "server = build_server();"
        "assert server is not None"
    )
    assert result.returncode == 0, result.stderr
