from __future__ import annotations

import argparse
import json
import subprocess

import pytest

from runtime import cli


@pytest.mark.parametrize("args", [["serve"], ["health"], ["chat", "hello"]])
def test_cli_requires_service_token_for_agent_commands(args, monkeypatch, capsys):
    monkeypatch.delenv("PYHFO_AGENT_SERVICE_TOKEN", raising=False)
    monkeypatch.delenv("AGENT_SERVICE_TOKEN", raising=False)
    with pytest.raises(SystemExit) as error:
        cli.main(args)
    assert error.value.code == 2
    assert "AGENT_SERVICE_TOKEN" in capsys.readouterr().err


def test_agent_service_spec_defaults_to_headless_backend_env(tmp_path, monkeypatch):
    monkeypatch.delenv("IEEG_AGENT_SKIP_TONE", raising=False)

    spec = cli.build_agent_service_spec(
        host="127.0.0.1",
        port=9001,
        token="agent-token",
        pyhfo_root=str(tmp_path),
        pyhfo_python="/usr/bin/python-pyhfo",
        enable_mcp=False,
    )

    assert spec.name == "agent"
    assert spec.command[-4:] == ["--host", "127.0.0.1", "--port", "9001"]
    assert spec.cwd == cli.REPO_ROOT
    assert spec.health_url == "http://127.0.0.1:9001/health"
    assert spec.env["AGENT_SERVICE_TOKEN"] == "agent-token"
    assert spec.env["PYHFO_AGENT_SERVICE_TOKEN"] == "agent-token"
    assert spec.env["PYHFO_AGENT_APP_ROOT"] == str(tmp_path)
    assert spec.env["PYHFO_AGENT_PYTHON"] == "/usr/bin/python-pyhfo"
    assert spec.env["IEEG_AGENT_SKIP_MCP"] == "1"
    assert spec.env["IEEG_AGENT_SKIP_TONE"] == "1"


def test_pyhfo_service_spec_uses_bundled_sidecar_server(tmp_path):
    spec = cli.build_pyhfo_service_spec(
        host="127.0.0.1",
        port=9900,
        token="pyhfo-token",
        agent_token="agent-token",
        agent_url="http://127.0.0.1:9001/internal/agent/v1/chat",
        pyhfo_root=str(tmp_path),
        pyhfo_python="/usr/bin/python-pyhfo",
    )

    assert spec.name == "pyhfo"
    assert spec.command == [
        "/usr/bin/python-pyhfo",
        "-m",
        "pyhfo.agent_api.server",
        "--host",
        "127.0.0.1",
        "--port",
        "9900",
    ]
    assert spec.cwd == tmp_path
    assert spec.env["PYHFO_BACKEND_TOKEN"] == "pyhfo-token"
    assert spec.env["PYHFO_AGENT_SERVICE_TOKEN"] == "agent-token"
    assert spec.env["PYHFO_AGENT_CHAT_URL"] == "http://127.0.0.1:9001/internal/agent/v1/chat"
    assert spec.health_url == "http://127.0.0.1:9900/health"


def test_pyhfo_passthrough_parser_preserves_nested_args():
    parser = cli.build_parser()
    args = parser.parse_args(["pyhfo", "--pyhfo-python", "/bin/py", "detect", "--input", "case.edf", "--output", "runs"])

    assert args.pyhfo_args == ["detect", "--input", "case.edf", "--output", "runs"]
    assert cli.build_pyhfo_cli_command(args.pyhfo_args, pyhfo_python=args.pyhfo_python) == [
        "/bin/py",
        "-m",
        "pyhfo.agent_cli",
        "detect",
        "--input",
        "case.edf",
        "--output",
        "runs",
    ]


def test_cmd_pyhfo_runs_from_configured_root(tmp_path, monkeypatch):
    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured["cwd"] = kwargs["cwd"]
        captured["env"] = kwargs["env"]
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(cli.subprocess, "run", fake_run)
    args = argparse.Namespace(
        pyhfo_args=["info", "--input", "case.edf"],
        pyhfo_root=str(tmp_path),
        pyhfo_python="/bin/pyhfo",
    )

    assert cli.cmd_pyhfo(args) == 0
    assert captured["command"] == ["/bin/pyhfo", "-m", "pyhfo.agent_cli", "info", "--input", "case.edf"]
    assert captured["cwd"] == str(tmp_path)
    assert captured["env"]["PYHFO_AGENT_APP_ROOT"] == str(tmp_path)


def test_chat_payload_is_backend_only_by_default():
    parser = cli.build_parser()
    args = parser.parse_args([
        "chat",
        "inspect this recording",
        "--recording",
        "case.edf",
        "--conversation-id",
        "conv-1",
        "--request-id",
        "req-1",
    ])

    payload = cli.build_chat_payload(args)

    assert payload["request_id"] == "req-1"
    assert payload["conversation_id"] == "conv-1"
    assert payload["message"] == "inspect this recording"
    assert payload["recording_path"] == "case.edf"
    assert payload["request_metadata"]["source"] == "backend-cli"
    assert payload["user_context"]["allowed_mcp_servers"] == []
    assert [item["name"] for item in payload["allowed_skills"]] == cli.DEFAULT_BACKEND_ALLOWED_SKILLS


def test_health_checks_agent_internal_and_pyhfo(monkeypatch, capsys):
    class FakeResponse:
        def __init__(self, payload):
            self.payload = payload

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def read(self):
            return json.dumps(self.payload).encode("utf-8")

    requested = []

    def fake_urlopen(request, timeout):
        requested.append(
            (
                request.full_url,
                request.headers.get("Authorization"),
                request.headers.get("X-contract-version"),
                timeout,
            )
        )
        if request.full_url.endswith("/internal/agent/v1/health"):
            return FakeResponse({"status": "healthy"})
        if request.full_url.endswith("/health"):
            return FakeResponse({"status": "ok"})
        return FakeResponse({"status": "unknown"})

    monkeypatch.setattr(cli, "urlopen", fake_urlopen)
    args = argparse.Namespace(
        agent_url="http://127.0.0.1:8001",
        pyhfo_url="http://127.0.0.1:8765",
        token="agent-token",
        pyhfo_token="pyhfo-token",
        timeout=0.1,
    )

    assert cli.cmd_health(args) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["status"] == "ok"
    assert (
        "http://127.0.0.1:8001/internal/agent/v1/health",
        "Bearer agent-token",
        cli.AGENT_CONTRACT_VERSION,
        0.1,
    ) in requested
    assert ("http://127.0.0.1:8765/health", "Bearer pyhfo-token", None, 0.1) in requested


def test_chat_binds_internal_agent_contract_version(monkeypatch, capsys):
    captured = {}

    def fake_request_json(url, **kwargs):
        captured["url"] = url
        captured.update(kwargs)
        return {"status": "completed", "content": "ok"}

    monkeypatch.setattr(cli, "_request_json", fake_request_json)
    args = cli.build_parser().parse_args(["chat", "--token", "test-token", "inspect this recording"])

    assert cli.cmd_chat(args) == 0
    assert capsys.readouterr().out.strip() == "ok"
    assert captured["url"].endswith("/internal/agent/v1/chat")
    assert captured["contract_version"] == cli.AGENT_CONTRACT_VERSION
