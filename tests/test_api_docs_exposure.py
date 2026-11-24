from fastapi.testclient import TestClient

from runtime.main import app


def test_agent_api_docs_are_disabled_by_default():
    client = TestClient(app)

    for path in ("/openapi.json", "/docs", "/redoc"):
        response = client.get(path)
        assert response.status_code == 404


def test_agent_health_includes_browser_security_headers():
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.headers["Strict-Transport-Security"].startswith("max-age=")
    assert "default-src" in response.headers["Content-Security-Policy"]
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert "geolocation=()" in response.headers["Permissions-Policy"]
