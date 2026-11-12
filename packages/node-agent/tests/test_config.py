"""配置 fail-closed 全矩阵（ADR §4）。"""
from __future__ import annotations

import json

import pytest

from agent_test_support import AgentSandbox, TEST_AGENT_VERSION
from ghostfleet_agent.config import (
    DEFAULT_CONFIG_PATH,
    DEFAULT_INTERVAL_S,
    MAX_ALLOWED_UNITS,
    MAX_INTERVAL_S,
    MIN_INTERVAL_S,
    ConfigError,
    default_node_meta_path,
    default_state_dir,
    default_token_path,
    load_config,
)

HTTPS = "https://control.example.test"


def _sandbox(tmp_path) -> AgentSandbox:
    return AgentSandbox(tmp_path)


def _load(tmp_path, document: dict):
    sandbox = _sandbox(tmp_path)
    path = sandbox.write_raw_config(json.dumps(document))
    return load_config(path)


def _base_document(tmp_path, **overrides) -> dict:
    sandbox = _sandbox(tmp_path)
    return sandbox.config_document(HTTPS, **overrides)


def test_valid_config_loads_with_defaults(tmp_path):
    document = _base_document(tmp_path, interval_s=15.0)
    document.pop("interval_s")
    document.pop("jitter_ratio")
    document.pop("request_timeout_s")
    document.pop("allowed_units")
    config = _load(tmp_path, document)
    assert config.control_plane_url == HTTPS
    assert config.interval_s == DEFAULT_INTERVAL_S
    assert config.jitter_ratio == 0.1
    assert config.request_timeout_s == 10.0
    assert config.allowed_units == ()
    assert config.loopback_http is False


def test_unknown_top_level_key_is_rejected(tmp_path):
    document = _base_document(tmp_path, extra_field="x")
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code == "CONFIG_UNKNOWN_KEY"


@pytest.mark.parametrize("key", ["control_plane_url"])
def test_missing_required_field_is_rejected(tmp_path, key):
    document = _base_document(tmp_path)
    document.pop(key)
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code == "CONFIG_MISSING_FIELD"


def test_missing_file_is_rejected(tmp_path):
    with pytest.raises(ConfigError) as error:
        load_config(str(tmp_path / "absent.json"))
    assert error.value.code == "CONFIG_FILE_MISSING"


def test_invalid_json_shapes_are_rejected(tmp_path):
    for text in ["", "{", "[]", "null", "42", "not json"]:
        sandbox = _sandbox(tmp_path)
        path = sandbox.write_raw_config(text)
        with pytest.raises(ConfigError) as error:
            load_config(path)
        assert error.value.code in {"CONFIG_JSON_INVALID", "CONFIG_NOT_OBJECT"}


def test_nan_infinity_and_duplicate_keys_are_rejected(tmp_path):
    for text in [
        '{"control_plane_url": NaN}',
        '{"control_plane_url": Infinity}',
        '{"control_plane_url": "' + HTTPS + '", "control_plane_url": "' + HTTPS + '"}',
    ]:
        sandbox = _sandbox(tmp_path)
        path = sandbox.write_raw_config(text)
        with pytest.raises(ConfigError) as error:
            load_config(path)
        assert error.value.code == "CONFIG_JSON_INVALID"


def test_non_utf8_config_is_rejected(tmp_path):
    sandbox = _sandbox(tmp_path)
    path = sandbox.config_path
    path.write_bytes(b"\xff\xfe{}")
    with pytest.raises(ConfigError) as error:
        load_config(path)
    assert error.value.code == "CONFIG_JSON_INVALID"


def test_oversize_config_is_rejected(tmp_path):
    sandbox = _sandbox(tmp_path)
    path = sandbox.write_raw_config(" " * (64 * 1024 + 2))
    with pytest.raises(ConfigError) as error:
        load_config(path)
    assert error.value.code == "CONFIG_VALUE_INVALID"


@pytest.mark.parametrize("name", ["token_path", "node_meta_path", "state_dir"])
def test_relative_paths_are_rejected(tmp_path, name):
    document = _base_document(tmp_path)
    document[name] = "relative/path"
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code == "CONFIG_VALUE_INVALID"


@pytest.mark.parametrize(
    "url",
    [
        "ftp://control.example.test",
        "http://control.example.test",
        "https://user:pass@control.example.test",
        "https://control.example.test/path?query=1",
        "https://control.example.test/path#fragment",
        "https://",
        "https://control.example.test:0",
        "https://control.example.test:70000",
        "not-a-url",
    ],
)
def test_unsafe_urls_are_rejected(tmp_path, url):
    document = _base_document(tmp_path, control_plane_url=url)
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code == "CONFIG_URL_INVALID"


@pytest.mark.parametrize("url", ["", None, 42])
def test_empty_or_non_string_url_is_rejected(tmp_path, url):
    document = _base_document(tmp_path, control_plane_url=url)
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code in {"CONFIG_URL_INVALID", "CONFIG_VALUE_INVALID", "CONFIG_TYPE_INVALID"}


def test_loopback_http_is_allowed_only_for_loopback(tmp_path):
    config = _load(tmp_path, _base_document(tmp_path, control_plane_url="http://127.0.0.1:8080"))
    assert config.loopback_http is True
    config = _load(tmp_path, _base_document(tmp_path, control_plane_url="http://[::1]:8080"))
    assert config.loopback_http is True
    config = _load(tmp_path, _base_document(tmp_path, control_plane_url="http://localhost:8080"))
    assert config.loopback_http is True


def test_loopback_http_is_forbidden_without_harness_opt_in(tmp_path, monkeypatch):
    monkeypatch.delenv("GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP", raising=False)
    sandbox = AgentSandbox(tmp_path)
    path = sandbox.write_raw_config(json.dumps(sandbox.config_document("http://127.0.0.1:8080")))
    with pytest.raises(ConfigError) as error:
        load_config(path)
    assert error.value.code == "CONFIG_LOOPBACK_HTTP_FORBIDDEN"
    assert error.value.field == "control_plane_url"


def test_loopback_http_opt_in_is_explicit_and_overrides_environment(tmp_path, monkeypatch):
    monkeypatch.delenv("GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP", raising=False)
    sandbox = AgentSandbox(tmp_path)
    path = sandbox.write_raw_config(json.dumps(sandbox.config_document("http://127.0.0.1:8080")))
    assert load_config(path, allow_loopback_http=True).loopback_http is True
    monkeypatch.setenv("GHOSTFLEET_AGENT_TEST_LOOPBACK_HTTP", "1")
    with pytest.raises(ConfigError) as error:
        load_config(path, allow_loopback_http=False)
    assert error.value.code == "CONFIG_LOOPBACK_HTTP_FORBIDDEN"


def test_url_trailing_slash_is_normalised(tmp_path):
    config = _load(tmp_path, _base_document(tmp_path, control_plane_url=HTTPS + "/"))
    assert config.control_plane_url == HTTPS


def test_interval_is_clamped(tmp_path):
    low = _load(tmp_path, _base_document(tmp_path, interval_s=1))
    assert low.interval_s == MIN_INTERVAL_S
    high = _load(tmp_path, _base_document(tmp_path, interval_s=10000))
    assert high.interval_s == MAX_INTERVAL_S


@pytest.mark.parametrize("value", ["thirty", True, None, [30]])
def test_interval_type_is_rejected(tmp_path, value):
    document = _base_document(tmp_path, interval_s=value)
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code == "CONFIG_TYPE_INVALID"


def test_jitter_ratio_is_clamped(tmp_path):
    config = _load(tmp_path, _base_document(tmp_path, jitter_ratio=9.0))
    assert config.jitter_ratio == 0.5
    config = _load(tmp_path, _base_document(tmp_path, jitter_ratio=-1.0))
    assert config.jitter_ratio == 0.0


def test_request_timeout_out_of_range_is_rejected(tmp_path):
    for value in (0.0, 0.05, 301, 10000):
        document = _base_document(tmp_path, request_timeout_s=value)
        with pytest.raises(ConfigError) as error:
            _load(tmp_path, document)
        assert error.value.code == "CONFIG_VALUE_INVALID"


@pytest.mark.parametrize("value", ["-4.2", "a b", "é", "x" * 80, "0.1\n"])
def test_agent_version_is_validated(tmp_path, value):
    document = _base_document(tmp_path, agent_version=value)
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code == "CONFIG_VALUE_INVALID"


def test_agent_version_accepts_semver_like_token(tmp_path):
    config = _load(tmp_path, _base_document(tmp_path, agent_version=TEST_AGENT_VERSION))
    assert config.agent_version == TEST_AGENT_VERSION


@pytest.mark.parametrize(
    "units",
    [
        ["a.service", "a.service"],
        ["ssh.service", "bad service"],
        ["ssh"],
        ["SSH.service"],
        [".service"],
        "ssh.service",
        list(f"svc{i}.service" for i in range(MAX_ALLOWED_UNITS + 1)),
    ],
)
def test_allowed_units_fail_closed(tmp_path, units):
    document = _base_document(tmp_path, allowed_units=units)
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code in {"CONFIG_UNIT_INVALID", "CONFIG_VALUE_INVALID", "CONFIG_TYPE_INVALID"}


def test_allowed_units_accepts_whitelist(tmp_path):
    config = _load(tmp_path, _base_document(tmp_path, allowed_units=["ssh.service", "demo@1.service"]))
    assert config.allowed_units == ("ssh.service", "demo@1.service")


def test_null_byte_is_rejected(tmp_path):
    document = _base_document(tmp_path, agent_version="0.1\x00")
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code == "CONFIG_VALUE_INVALID"


def test_config_is_frozen(tmp_path):
    config = _load(tmp_path, _base_document(tmp_path))
    with pytest.raises(Exception):
        config.interval_s = 1.0


# -- ADR §4 路径契约：root-owned 配置 + 用户态凭据/运行态 ---------------------
def test_default_paths_follow_adr_layout(tmp_path):
    home = str(tmp_path / "home")
    assert default_token_path(home) == f"{home}/.config/ghostfleet/node-token"
    assert default_node_meta_path(home) == f"{home}/.config/ghostfleet/node.json"
    assert default_state_dir(home) == f"{home}/.local/state/ghostfleet-agent"
    assert DEFAULT_CONFIG_PATH == "/etc/ghostfleet/node-agent.json"


def test_home_defaults_are_used_when_paths_omitted(tmp_path):
    document = _base_document(tmp_path)
    for key in ("token_path", "node_meta_path", "state_dir", "agent_version"):
        document.pop(key)
    config = _load(tmp_path, document)
    home = str(tmp_path)
    # AgentSandbox 把 HOME 相关默认值显式传入了 token/meta/state；这里只验证缺省
    # 路径字段不会导致配置被拒，且解析出的值仍然是绝对路径。
    for value in (config.token_path, config.node_meta_path, config.state_dir):
        assert value.startswith("/")
    assert config.agent_version


def test_origin_alias_is_accepted_and_collision_rejected(tmp_path):
    document = _base_document(tmp_path)
    document.pop("control_plane_url")
    document["control_plane_origin"] = HTTPS
    config = _load(tmp_path, document)
    assert config.control_plane_url == HTTPS
    assert config.control_plane_host == "control.example.test"

    document = _base_document(tmp_path, control_plane_origin="https://other.example.test")
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code in ("CONFIG_VALUE_INVALID", "CONFIG_UNKNOWN_KEY")


def test_heartbeat_interval_bounds_are_validated(tmp_path):
    document = _base_document(tmp_path, heartbeat_interval_min_s=20, heartbeat_interval_max_s=60)
    config = _load(tmp_path, document)
    assert config.interval_bounds == (20.0, 60.0)

    document = _base_document(tmp_path, heartbeat_interval_min_s=120, heartbeat_interval_max_s=60)
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code == "CONFIG_VALUE_INVALID"

    document = _base_document(tmp_path, heartbeat_interval_max_s=10000)
    with pytest.raises(ConfigError) as error:
        _load(tmp_path, document)
    assert error.value.code == "CONFIG_VALUE_INVALID"


def test_heartbeat_interval_is_clamped_into_bounds(tmp_path):
    config = _load(tmp_path, _base_document(tmp_path, heartbeat_interval_min_s=60, heartbeat_interval_max_s=60))
    assert config.interval_s == 60.0
