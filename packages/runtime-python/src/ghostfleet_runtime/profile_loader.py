"""Compatibility shim for :mod:`ghostfleet_runtime.core.profile_loader`.

Canonical implementation moved by Fleet Directory 3.0.0. New code should import
`ghostfleet_runtime.core.profile_loader` directly.
"""
from .core import profile_loader as _impl

for _name in dir(_impl):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_impl, _name)

del _name, _impl
