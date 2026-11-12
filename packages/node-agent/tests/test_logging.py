"""logging：单行 JSON、有界字段、脱敏（secret/base64url/短码/敏感键）。"""
from __future__ import annotations

import io
import json
import math

import pytest

from ghostfleet_agent import logging as agent_logging
from ghostfleet_agent.logging import (
    LOG_LEVEL_ERROR,
    LOG_LEVEL_INFO,
    LOG_LEVEL_WARNING,
    MAX_FIELDS,
    MAX_STRING_CHARS,
    REDACTED,
    SENSITIVE_KEYS,
    Logger,
    clear_secrets,
    configure,
    get_logger,
    log_event,
    redact,
    redact_string,
    register_secret,
)

LONG_SECRET = "s" * 40


@pytest.fixture(autouse=True)
def _clean_secrets():
    clear_secrets()
    yield
    clear_secrets()


def emit(**fields):
    stream = io.StringIO()
    Logger(stream).info("test_event", **fields)
    return json.loads(stream.getvalue())


def raw_line(**fields):
    stream = io.StringIO()
    Logger(stream).warning("test_event", **fields)
    return stream.getvalue()


# -- 基本形态 ---------------------------------------------------------------
def test_single_line_json_record():
    line = raw_line(uid="node-1")
    assert line.endswith("\n")
    assert line.count("\n") == 1
    record = json.loads(line)
    assert record["level"] == LOG_LEVEL_WARNING
    assert record["event"] == "test_event"
    assert record["uid"] == "node-1"
    assert len(record["ts"]) == 20 and record["ts"].endswith("Z")


def test_levels_are_recorded():
    for level in (LOG_LEVEL_INFO, LOG_LEVEL_WARNING, LOG_LEVEL_ERROR):
        stream = io.StringIO()
        Logger(stream).emit(level, "e")
        assert json.loads(stream.getvalue())["level"] == level


def test_scalar_fields_are_preserved():
    record = emit(count=3, ratio=0.5, active=True, missing=None, name="agent")
    assert record["count"] == 3
    assert record["ratio"] == 0.5
    assert record["active"] is True
    assert record["missing"] is None
    assert record["name"] == "agent"


def test_reserved_keys_cannot_be_overwritten():
    # Logger.emit 的固定字段不能被调用方 fields 覆盖（防空转/伪造级别）。
    stream = io.StringIO()
    Logger(stream).emit(LOG_LEVEL_WARNING, "test_event", {"event": "spoofed", "ts": "spoofed", "level": "spoofed"})
    record = json.loads(stream.getvalue().strip())
    assert record["event"] == "test_event"
    assert record["level"] == LOG_LEVEL_WARNING
    assert record["ts"] != "spoofed"


def test_field_count_is_bounded():
    record = emit(**{f"key{index}": index for index in range(MAX_FIELDS + 10)})
    assert len(record) <= 3 + MAX_FIELDS


# -- 脱敏 -------------------------------------------------------------------
def test_sensitive_keys_are_always_redacted():
    record = emit(token="abc", authorization="Bearer x", password="pw", api_key="k")
    assert record["token"] == REDACTED
    assert record["authorization"] == REDACTED
    assert record["password"] == REDACTED
    assert record["api_key"] == REDACTED


def test_registered_secret_is_redacted_everywhere():
    register_secret(LONG_SECRET)
    record = emit(message=f"prefix {LONG_SECRET} suffix", nested={"text": LONG_SECRET})
    assert LONG_SECRET not in json.dumps(record)
    assert record["message"].startswith("prefix ")
    assert record["nested"]["text"] == REDACTED


def test_short_secret_is_not_registered():
    register_secret("short")
    record = emit(note="short")
    assert record["note"] == "short"


def test_base64url_run_is_redacted():
    run = "A" * 32
    record = emit(blob=f"value={run}")
    assert record["blob"] == f"value={REDACTED}"


def test_short_code_is_redacted():
    record = emit(note="code ABCD-EFGH ready")
    assert record["note"] == f"code {REDACTED} ready"


def test_control_characters_are_replaced():
    record = emit(note="line1\nline2\x00end")
    assert "\n" not in record["note"]
    assert "\x00" not in record["note"]


def test_long_strings_are_truncated():
    # 不要用单一长 base64url 串：那会被整段替换成 [REDACTED]（正确的脱敏行为）。
    text = redact_string("word " * 50)
    assert len(text) == MAX_STRING_CHARS + 1
    assert text.endswith("…")


def test_nested_values_are_bounded():
    record = emit(
        items=list(range(20)),
        mapping={f"k{index}": index for index in range(30)},
        deep=[{"a": {"b": {"c": 1}}}],
    )
    items = record["items"]
    assert items[:8] == list(range(8))
    assert items[-1] == "<+12 more>"
    assert "<truncated>" in record["mapping"]
    assert record["deep"][0]["a"] == "<bounded dict>"


def test_non_finite_float_becomes_null():
    record = emit(value=float("nan"), other=float("inf"))
    assert record["value"] is None
    assert record["other"] is None
    assert math.isnan(float("nan"))


def test_redact_reports_bounded_containers_by_name():
    assert redact([[1]], depth=2) == "<bounded list>"
    assert redact("x" * 200, key="password") == REDACTED


# -- 健壮性 ----------------------------------------------------------------
def test_unwritable_stream_never_raises():
    class Boom:
        def write(self, text):
            raise RuntimeError("disk on fire")

        def flush(self):
            raise RuntimeError("disk on fire")

    Logger(Boom()).info("still_fine", detail="x")


def test_configure_and_log_event_use_module_logger():
    stream = io.StringIO()
    try:
        configured = configure(stream)
        assert get_logger() is configured
        log_event("module_event", component="loop")
        record = json.loads(stream.getvalue())
        assert record["event"] == "module_event"
        assert record["component"] == "loop"
    finally:
        configure(None)


def test_sensitive_keys_constant_covers_credentials():
    for key in ("token", "authorization", "password", "private_key", "resume_session"):
        assert key in SENSITIVE_KEYS
    assert agent_logging.REDACTED == "[REDACTED]"
