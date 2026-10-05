"""Optional uiautomator2 device adapter.

The adapter is optional and lazy: importing this module (or the canonical
package) never requires uiautomator2/tesseract to be installed. Only
constructing the device triggers the optional imports.

Exposes only the whitelisted primitives from the DeviceAdapter contract.
There is no arbitrary shell/ADB passthrough API.

Artifact/screenshot paths are configurable via ``artifact_dir`` or the
``AI_HUB_ANDROID_ARTIFACT_DIR`` environment variable; the default is a
platform-neutral temp location and never a consumer deployment path.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import uuid
import stat
import time
from pathlib import Path

from ghostfleet_runtime.android.runtime import DeviceError
from ghostfleet_runtime.android.schemas import DeviceStatus, OcrBlock, PageState, UiNode


def default_artifact_dir() -> Path:
    """Platform-neutral default artifact directory (configurable)."""
    env = os.environ.get("GHOSTFLEET_ANDROID_ARTIFACT_DIR")
    if env:
        return Path(env)
    return Path(tempfile.gettempdir()) / "ghostfleet-android-artifacts"


class Uiautomator2Device:
    """Wrap a uiautomator2 connection behind the whitelisted primitives."""

    def __init__(
        self,
        serial: str | None = None,
        artifact_dir: Path | None = None,
        screenshot_dir: Path | None = None,
    ) -> None:
        import uiautomator2 as u2  # optional dependency, lazily imported

        self._u2 = u2
        self.serial = serial or "default"
        self._d = u2.connect(self.serial if serial else None)
        self._artifact_dir = Path(artifact_dir or screenshot_dir or default_artifact_dir())

    # ---------- state ----------

    def status(self) -> DeviceStatus:
        try:
            info = self._d.info
            app = self._d.app_current()
        except Exception as e:  # noqa: BLE001
            raise DeviceError(f"device not reachable: {e}") from e
        return DeviceStatus(
            online=True,
            serial=self.serial,
            model=info.get("productName"),
            android_version=str(info.get("sdkInt", "")),
            screen_on=info.get("screenOn"),
            battery=self._battery_level(),
            current_package=app.get("package"),
            current_activity=app.get("activity"),
        )

    def current_app(self) -> dict:
        try:
            app = self._d.app_current()
        except Exception as e:  # noqa: BLE001
            raise DeviceError(f"app_current failed: {e}") from e
        return {"package": app.get("package"), "activity": app.get("activity")}

    def screen_size(self) -> tuple[int, int] | None:
        """Return (width, height) or None when unavailable."""
        try:
            w = self._d.info.get("displayWidth")
            h = self._d.info.get("displayHeight")
            if w and h:
                return int(w), int(h)
        except Exception:  # noqa: BLE001
            pass
        try:
            size = self._d.window_size()
            return int(size[0]), int(size[1])
        except Exception:  # noqa: BLE001
            return None

    def _battery_level(self) -> int | None:
        try:
            out = self._d.shell("dumpsys battery").output.strip()
            for line in out.splitlines():
                if "level:" in line:
                    return int(line.split(":", 1)[1].strip())
        except Exception:  # noqa: BLE001
            return None
        return None

    def wake(self) -> None:
        """Pure screen wake; never unlocks the device.

        Screen wake is an adapter convenience only. It is NOT a canonical
        runtime action (``wake`` is absent from ``KNOWN_ACTIONS``) and performs
        no unlock/credential operation: unlock material remains a trusted
        external capability consumed by the device, never by the platform.
        """
        if not self._d.info.get("screenOn"):
            self._d.screen_on()
            time.sleep(1.0)

    # ---------- whitelisted primitives ----------

    def open_app(self, package: str) -> None:
        self._d.app_start(package, stop=True)
        time.sleep(0.8)

    def restart_app(self, package: str) -> None:
        self.open_app(package)

    def tap_text(self, text: str) -> None:
        el = self._d(text=text)
        if not el.exists(timeout=5.0):
            raise DeviceError(f"text not found")
        el.click()
        time.sleep(0.5)

    def tap_position(self, x: int, y: int) -> None:
        self._d.click(x, y)
        time.sleep(0.5)

    def input_text(self, text: str) -> None:
        """Controlled text input via send_keys; value is never logged."""
        if not text:
            raise ValueError("text required")
        try:
            self._d.send_keys(text)
            time.sleep(0.3)
        except Exception as e:  # noqa: BLE001
            raise DeviceError("input_text failed") from e

    def swipe(self, fx: int, fy: int, tx: int, ty: int, duration_ms: int) -> None:
        self._d.swipe(fx, fy, tx, ty, duration=duration_ms / 1000.0)
        time.sleep(0.5)

    def press_back(self) -> None:
        self._d.press("back")
        time.sleep(0.5)

    def read_ui_tree(self) -> PageState:
        app = self._d.app_current()
        xml = self._d.dump_hierarchy()
        tree = self._parse_hierarchy(xml)
        title = self._extract_title(tree)
        fingerprint = hashlib.sha256(xml.encode("utf-8")).hexdigest()[:16]
        return PageState(
            package=app.get("package", ""),
            activity=app.get("activity"),
            title=title,
            nodes=tree,
            fingerprint=fingerprint,
        )

    def read_page(self) -> PageState:
        """Hybrid read: UI tree first; fall back to screenshot OCR."""
        page = self.read_ui_tree()
        if self._has_meaningful_content(page):
            return page
        shot = self.take_screenshot()
        blocks = self.ocr_image(shot)
        fingerprint = hashlib.sha256(
            "\n".join(f"{b.left},{b.top}:{b.text}" for b in blocks).encode("utf-8")
        ).hexdigest()[:16]
        title = self._extract_ocr_title(blocks)
        return PageState(
            package=page.package,
            activity=page.activity,
            title=title,
            fingerprint=fingerprint,
            source="ocr",
            ocr_blocks=blocks,
        )

    def ocr_image(self, path: Path) -> list[OcrBlock]:
        """Run tesseract OCR with a fixed, non-user-injectable command line."""
        import csv
        import subprocess

        out_base = str(path.with_suffix(""))
        try:
            subprocess.run(
                [
                    "tesseract", str(path),
                    out_base,
                    "-l", "chi_sim+eng",
                    "--psm", "3",
                    "tsv",
                ],
                capture_output=True,
                timeout=60,
                check=False,
            )
        except Exception as e:  # noqa: BLE001
            raise DeviceError(f"ocr failed: {e}") from e
        blocks: list[OcrBlock] = []
        tsv = Path(out_base + ".tsv")
        try:
            with open(tsv, newline="", encoding="utf-8") as f:
                for row in csv.reader(f, delimiter="\t"):
                    if len(row) < 12 or not row[11].strip():
                        continue
                    try:
                        conf = float(row[10])
                    except ValueError:
                        continue
                    if conf < 40:
                        continue
                    blocks.append(
                        OcrBlock(
                            text=row[11].strip(),
                            confidence=conf,
                            left=int(row[6]),
                            top=int(row[7]),
                            width=int(row[8]),
                            height=int(row[9]),
                        )
                    )
        except FileNotFoundError:
            pass
        finally:
            tsv.unlink(missing_ok=True)
        return blocks

    def take_screenshot(self) -> Path:
        directory=self._artifact_dir.absolute()
        if any(path.is_symlink() for path in (directory,*directory.parents)):
            raise DeviceError("ARTIFACT_DIRECTORY_UNTRUSTED")
        directory.mkdir(mode=0o700,parents=True,exist_ok=True)
        info=directory.stat()
        if os.name!="nt" and (info.st_uid!=os.geteuid() or info.st_mode & 0o077):
            raise DeviceError("ARTIFACT_DIRECTORY_UNTRUSTED")
        ts = time.strftime("%Y%m%d_%H%M%S")
        path = directory / f"screen_{ts}_{uuid.uuid4().hex}.png"
        self._d.screenshot(str(path))
        if path.is_symlink() or not path.is_file():
            raise DeviceError("ARTIFACT_FILE_UNTRUSTED")
        if os.name!="nt":path.chmod(0o600)
        return path

    # ---------- UI tree parsing (pure, deterministic) ----------

    @staticmethod
    def _parse_hierarchy(xml: str) -> list[UiNode]:
        """Lightweight XML parse; only visible meaningful nodes are kept."""
        import xml.etree.ElementTree as ET

        try:
            root = ET.fromstring(xml)
        except ET.ParseError:
            return []
        nodes: list[UiNode] = []

        def walk(el, depth: int) -> None:
            if depth > 30:
                return
            if el.tag == "node":
                visible = el.get("visible-to-user", "false") == "true"
                if visible:
                    text = el.get("text") or None
                    content_desc = el.get("content-desc") or None
                    resource_id = el.get("resource-id") or None
                    if text or content_desc or resource_id:
                        nodes.append(
                            UiNode(
                                text=text,
                                resource_id=resource_id,
                                class_name=el.get("class") or None,
                                content_desc=content_desc,
                                bounds=el.get("bounds"),
                                clickable=el.get("clickable") == "true",
                                enabled=el.get("enabled") != "false",
                            )
                        )
            for child in el:
                walk(child, depth + 1)

        walk(root, 0)
        return nodes

    @staticmethod
    def _extract_title(nodes: list[UiNode]) -> str | None:
        """Most likely title: a text node near the top/center."""
        for n in nodes:
            if n.text and len(n.text) <= 30:
                return n.text
        return None

    @staticmethod
    def _has_meaningful_content(page: PageState) -> bool:
        """True when the UI tree has app content (exclude system UI)."""
        for n in page.nodes:
            rid = n.resource_id or ""
            if n.text and not rid.startswith("com.android.systemui"):
                return True
        return False

    @staticmethod
    def _extract_ocr_title(blocks: list[OcrBlock]) -> str | None:
        """OCR fallback title from the top band of blocks."""
        top = min((b.top for b in blocks), default=10**9)
        if top == 10**9:
            return None
        band = [b for b in blocks if b.top <= top + 60 and len(b.text) >= 2]
        if not band:
            return None
        band.sort(key=lambda b: (b.confidence, b.height), reverse=True)
        return band[0].text
