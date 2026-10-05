"""Compatibility shim for :mod:`ghostfleet_runtime.core.node_identity`.

Canonical implementation moved by Fleet Directory 3.0.0. New code should import
`ghostfleet_runtime.core.node_identity` directly.
"""
from .core import node_identity as _impl

for _name in dir(_impl):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_impl, _name)

del _name, _impl
