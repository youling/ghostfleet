"""Domain-neutral DTOs for Android/device-control operations.

Field semantics mirror the proven cross-project consumer contract
(DeviceStatus / PageState / UiNode / OcrBlock / ActionResult /
ScreenshotResult) so consumers can build adapters without source-copying.
Dataclasses + ``to_dict()`` keep the contract dependency-free (stdlib only).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass
class UiNode:
    """A visible node from an Android UI tree."""

    text: str | None = None
    resource_id: str | None = None
    class_name: str | None = None
    content_desc: str | None = None
    bounds: str | None = None
    clickable: bool = False
    enabled: bool = True
    children: list["UiNode"] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "resource_id": self.resource_id,
            "class_name": self.class_name,
            "content_desc": self.content_desc,
            "bounds": self.bounds,
            "clickable": self.clickable,
            "enabled": self.enabled,
            "children": [c.to_dict() for c in self.children],
        }


@dataclass
class OcrBlock:
    """A text block returned by OCR."""

    text: str
    confidence: float
    left: int
    top: int
    width: int
    height: int

    def to_dict(self) -> dict:
        return {
            "text": self.text,
            "confidence": self.confidence,
            "left": self.left,
            "top": self.top,
            "width": self.width,
            "height": self.height,
        }


@dataclass
class DeviceStatus:
    """Device-level health/state snapshot."""

    online: bool
    serial: str
    model: str | None = None
    android_version: str | None = None
    screen_on: bool | None = None
    battery: int | None = None
    current_package: str | None = None
    current_activity: str | None = None

    def to_dict(self) -> dict:
        return {
            "online": self.online,
            "serial": self.serial,
            "model": self.model,
            "android_version": self.android_version,
            "screen_on": self.screen_on,
            "battery": self.battery,
            "current_package": self.current_package,
            "current_activity": self.current_activity,
        }


@dataclass
class PageState:
    """A page observation: UI tree (and OCR fallback) for one screen."""

    package: str
    activity: str | None = None
    title: str | None = None
    nodes: list[UiNode] = field(default_factory=list)
    fingerprint: str | None = None
    source: Literal["ui_tree", "ocr"] = "ui_tree"
    ocr_blocks: list[OcrBlock] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "package": self.package,
            "activity": self.activity,
            "title": self.title,
            "nodes": [n.to_dict() for n in self.nodes],
            "fingerprint": self.fingerprint,
            "source": self.source,
            "ocr_blocks": [b.to_dict() for b in self.ocr_blocks],
        }


@dataclass
class ActionResult:
    """Action response model (consumer transport contract)."""

    ok: bool
    action: str
    detail: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {"ok": self.ok, "action": self.action, "detail": self.detail}


@dataclass
class ScreenshotResult:
    """Screenshot response model (consumer transport contract)."""

    ok: bool
    path: str | None = None
    width: int | None = None
    height: int | None = None

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "path": self.path,
            "width": self.width,
            "height": self.height,
        }


@dataclass
class ActionRequest:
    """A unified action request.

    Fields are deliberately loose (``object``): any JSON value passes the
    transport layer and reaches Policy, which performs uniform type/domain
    validation and fails closed with an auditable trace. Only gross
    transport-shape failures (e.g. request body not an object) stay at the
    framework layer.
    """

    action: Any = None
    package: Any = None
    text: Any = None
    x: Any = None
    y: Any = None
    fx: Any = None
    fy: Any = None
    tx: Any = None
    ty: Any = None
    duration_ms: Any = None
    reason: Any = None