"""Tests for StorageService abstraction layer."""
import pytest
from unittest.mock import MagicMock, patch


class TestLocalStorage:
    def test_default_storage_round_trips_image_references(self, tmp_path, monkeypatch):
        from runtime.agent_runtime.image_reference_store import ImageReferenceStore
        from runtime.services import storage_service
        from runtime.services.image_persistence_service import ImagePersistenceService

        monkeypatch.delenv("AGENT_STORAGE_BACKEND", raising=False)
        monkeypatch.delenv("IEEG_STORAGE_BACKEND", raising=False)
        monkeypatch.setenv("IEEG_STORAGE_LOCAL_ROOT", str(tmp_path))
        monkeypatch.setattr(storage_service, "_storage_service", None)
        assert storage_service.get_storage_service().backend_name == "local"

        store = ImageReferenceStore(conversation_id="test-conversation")
        ref = store.store_upload(data="aW1hZ2U=")
        assert ref.data is None
        assert store.get(ref.ref_id).data == "aW1hZ2U="

        image = ImagePersistenceService().store_image("test-conversation", data="aW1hZ2U=")
        assert image.data is None
        assert image.ensure_data() == "aW1hZ2U="

    def test_local_paths_must_stay_inside_bucket(self, tmp_path):
        from runtime.services.storage_service import StorageService

        svc = StorageService(backend="local", local_root=tmp_path)
        with pytest.raises(ValueError, match="bucket"):
            svc.ensure_bucket("..")
        with pytest.raises(ValueError, match="key"):
            svc.put_object("test-bucket", "../outside", b"data")

    def test_put_and_get_object(self, tmp_path):
        from runtime.services.storage_service import StorageService
        svc = StorageService(backend="local", local_root=tmp_path)
        svc.put_object("test-bucket", "img/hello.jpg", b"\xff\xd8\xff\xe0", "image/jpeg")
        data = svc.get_object("test-bucket", "img/hello.jpg")
        assert data == b"\xff\xd8\xff\xe0"

    def test_object_exists(self, tmp_path):
        from runtime.services.storage_service import StorageService
        svc = StorageService(backend="local", local_root=tmp_path)
        assert not svc.object_exists("b", "k")
        svc.put_object("b", "k", b"data", "text/plain")
        assert svc.object_exists("b", "k")

    def test_delete_object(self, tmp_path):
        from runtime.services.storage_service import StorageService
        svc = StorageService(backend="local", local_root=tmp_path)
        svc.put_object("b", "k", b"data", "text/plain")
        assert svc.delete_object("b", "k")
        assert not svc.object_exists("b", "k")

    def test_delete_nonexistent_returns_false(self, tmp_path):
        from runtime.services.storage_service import StorageService
        svc = StorageService(backend="local", local_root=tmp_path)
        assert not svc.delete_object("b", "missing")

    def test_get_presigned_url_local(self, tmp_path):
        from runtime.services.storage_service import StorageService
        svc = StorageService(backend="local", local_root=tmp_path)
        svc.put_object("b", "k", b"data", "text/plain")
        url = svc.get_presigned_url("b", "k", expires_seconds=3600)
        assert "/local-storage/b/k" in url

    def test_get_object_missing_returns_none(self, tmp_path):
        from runtime.services.storage_service import StorageService
        svc = StorageService(backend="local", local_root=tmp_path)
        assert svc.get_object("b", "missing") is None

    def test_ensure_bucket_creates_dir(self, tmp_path):
        from runtime.services.storage_service import StorageService
        svc = StorageService(backend="local", local_root=tmp_path)
        svc.ensure_bucket("new-bucket")
        assert (tmp_path / "new-bucket").is_dir()


class TestS3Storage:
    def test_configured_endpoint_uses_sdk_credentials(self, monkeypatch):
        from runtime.services.storage_service import StorageService

        monkeypatch.setenv("IEEG_STORAGE_BACKEND", "s3")
        monkeypatch.setenv("IEEG_S3_ENDPOINT_URL", "https://storage.example.invalid")
        with patch("boto3.client") as client:
            assert StorageService().backend_name == "s3"
        args, kwargs = client.call_args
        assert args == ("s3",)
        assert kwargs["endpoint_url"] == "https://storage.example.invalid"
        assert "aws_access_key_id" not in kwargs
        assert "aws_secret_access_key" not in kwargs

    def _make_svc(self):
        from runtime.services.storage_service import StorageService
        svc = StorageService.__new__(StorageService)
        svc._backend = "s3"
        svc._local_root = None
        svc._s3_client = MagicMock()
        return svc

    def test_put_object_calls_s3(self):
        svc = self._make_svc()
        svc.put_object("bucket", "key", b"data", "text/plain")
        svc._s3_client.put_object.assert_called_once_with(
            Bucket="bucket", Key="key", Body=b"data", ContentType="text/plain"
        )

    def test_get_object_calls_s3(self):
        svc = self._make_svc()
        mock_body = MagicMock()
        mock_body.read.return_value = b"bytes"
        svc._s3_client.get_object.return_value = {"Body": mock_body}
        data = svc.get_object("bucket", "key")
        assert data == b"bytes"

    def test_get_object_missing_returns_none(self):
        from botocore.exceptions import ClientError
        svc = self._make_svc()
        svc._s3_client.get_object.side_effect = ClientError(
            {"Error": {"Code": "NoSuchKey"}}, "GetObject"
        )
        assert svc.get_object("bucket", "missing") is None

    def test_get_presigned_url(self):
        svc = self._make_svc()
        svc._s3_client.generate_presigned_url.return_value = "https://storage.example.invalid/bucket/key?X-Amz-Signature=example"
        url = svc.get_presigned_url("bucket", "key", expires_seconds=3600)
        assert "X-Amz-Signature" in url

    def test_delete_object_calls_s3(self):
        svc = self._make_svc()
        svc._s3_client.delete_object.return_value = {}
        assert svc.delete_object("bucket", "key")

    def test_object_exists_true(self):
        svc = self._make_svc()
        svc._s3_client.head_object.return_value = {"ContentLength": 10}
        assert svc.object_exists("bucket", "key")

    def test_object_exists_false(self):
        from botocore.exceptions import ClientError
        svc = self._make_svc()
        svc._s3_client.head_object.side_effect = ClientError(
            {"Error": {"Code": "404"}}, "HeadObject"
        )
        assert not svc.object_exists("bucket", "key")

    def test_ensure_bucket_creates_if_missing(self):
        from botocore.exceptions import ClientError
        svc = self._make_svc()
        svc._s3_client.head_bucket.side_effect = ClientError(
            {"Error": {"Code": "404"}}, "HeadBucket"
        )
        svc.ensure_bucket("new-bucket")
        svc._s3_client.create_bucket.assert_called_once_with(Bucket="new-bucket")


class TestEndpointUnreachable:
    """Unreachable S3 endpoints warn once and skip later network calls."""

    def _make_svc(self):
        from runtime.services.storage_service import StorageService
        svc = StorageService.__new__(StorageService)
        svc._backend = "s3"
        svc._local_root = None
        svc._endpoint_down = False
        svc._s3_client = MagicMock()
        return svc

    def _endpoint_error(self):
        from botocore.exceptions import EndpointConnectionError
        return EndpointConnectionError(endpoint_url="http://localhost:9000")

    def test_put_object_first_failure_warns_once_and_marks_down(self, caplog):
        from runtime.services.storage_service import StorageUnavailableError
        svc = self._make_svc()
        svc._s3_client.put_object.side_effect = self._endpoint_error()

        with caplog.at_level("WARNING", logger="runtime.services.storage_service"):
            with pytest.raises(StorageUnavailableError):
                svc.put_object("ieeg-chat-uploads", "k", b"data", "image/jpeg")

        assert svc._endpoint_down is True
        warnings = [r for r in caplog.records if r.levelname == "WARNING"]
        assert len(warnings) == 1
        # A concise warning — not a botocore traceback attached to the record.
        assert warnings[0].exc_info is None

    def test_subsequent_calls_short_circuit_without_hitting_client(self, caplog):
        from runtime.services.storage_service import StorageUnavailableError
        svc = self._make_svc()
        svc._s3_client.put_object.side_effect = self._endpoint_error()

        with caplog.at_level("WARNING", logger="runtime.services.storage_service"):
            with pytest.raises(StorageUnavailableError):
                svc.put_object("b", "k", b"d", "image/jpeg")
            svc._s3_client.put_object.reset_mock()
            # Second turn: must NOT call boto again, must NOT log a second warning.
            with pytest.raises(StorageUnavailableError):
                svc.put_object("b", "k2", b"d2", "image/jpeg")

        svc._s3_client.put_object.assert_not_called()
        assert len([r for r in caplog.records if r.levelname == "WARNING"]) == 1

    def test_read_methods_degrade_quietly_when_endpoint_down(self):
        svc = self._make_svc()
        svc._endpoint_down = True
        # No exception escapes; reads simply report "not found".
        assert svc.get_object("b", "k") is None
        assert svc.object_exists("b", "k") is False
        assert svc.delete_object("b", "k") is False
        svc._s3_client.get_object.assert_not_called()

    def test_client_error_is_not_treated_as_endpoint_down(self):
        from botocore.exceptions import ClientError
        svc = self._make_svc()
        svc._s3_client.get_object.side_effect = ClientError(
            {"Error": {"Code": "NoSuchKey"}}, "GetObject"
        )
        # A normal missing-key error must still return None and must NOT trip the breaker.
        assert svc.get_object("b", "missing") is None
        assert svc._endpoint_down is False
