"""Process-local name resolution for the journey suite.

Maps the suite's two local hostnames to 127.0.0.1 by overriding
`socket.getaddrinfo` in whatever process imports and installs it — and only
there. The system resolver, host git, and host `gh` are untouched: this
override lives only in processes the suite starts (the runner via
stack/runnerbox.py, the edge and future orchestrator helpers), never in the
host shell, and the system /etc/hosts is never edited.

    import localresolve
    localresolve.install()
"""

import socket

#: The only names this suite answers for. Everything else — including the
#: real github.com — resolves exactly as the operating system would.
LOCAL_NAMES = frozenset({"cogbox.local", "api.github.com"})

_original_getaddrinfo = socket.getaddrinfo


def _patched_getaddrinfo(host, port, family=0, socktype=0, proto=0, flags=0):
    if isinstance(host, str) and host in LOCAL_NAMES:
        # Resolve the service/port against the loopback address itself, so
        # numeric ports and service names both behave like the real call.
        return _original_getaddrinfo(
            "127.0.0.1", port, family, socktype, proto, flags
        )
    return _original_getaddrinfo(host, port, family, socktype, proto, flags)


def install() -> None:
    """Point this process's getaddrinfo at the local edge. Idempotent."""
    socket.getaddrinfo = _patched_getaddrinfo
