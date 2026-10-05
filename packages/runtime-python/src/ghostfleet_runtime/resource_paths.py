"""Resolve packaged mechanism resources or an explicitly selected resource installation."""
from pathlib import Path
import os

def resource_root(root: str | Path | None = None) -> Path:
    selected = root or os.environ.get("GHOSTFLEET_RESOURCE_ROOT")
    path = Path(selected) if selected else Path(__file__).resolve().parent / "resources"
    if not path.is_absolute():
        raise ValueError("RESOURCE_ROOT_MUST_BE_ABSOLUTE")
    resolved = path.resolve(strict=True)
    if not resolved.is_dir():
        raise ValueError("RESOURCE_ROOT_MUST_BE_DIRECTORY")
    return resolved

def resource_path(relative: str, root: str | Path | None = None) -> Path:
    base = resource_root(root)
    path = (base / relative).resolve(strict=True)
    if not path.is_relative_to(base) or not path.is_file():
        raise ValueError("RESOURCE_PATH_OUTSIDE_PACKAGE")
    return path
