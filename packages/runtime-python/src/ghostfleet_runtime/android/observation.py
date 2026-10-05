"""UI observation: safe view of a page for Policy and Trace.

Observation retains meaningful nodes (text / content-desc / resource-id /
clickable) so the classification path never loses them. It does not hold
secret payloads.
"""

from __future__ import annotations

from ghostfleet_runtime.android.schemas import PageState


class Observation:
    """A safe view of one page observation."""

    def __init__(self, page: PageState) -> None:
        self.page = page

    @property
    def title(self) -> str | None:
        return self.page.title

    @property
    def fingerprint(self) -> str | None:
        return self.page.fingerprint

    @property
    def texts(self) -> list[str]:
        """Collect texts from meaningful nodes; text and content-desc kept."""
        out: list[str] = []
        for n in getattr(self.page, "nodes", []):
            if n.text:
                out.append(n.text)
            if n.content_desc:
                out.append(n.content_desc)
        for b in getattr(self.page, "ocr_blocks", []):
            out.append(b.text)
        return out


def observe(device) -> Observation:
    """Read the current page and wrap it as an Observation."""
    return Observation(device.read_page())