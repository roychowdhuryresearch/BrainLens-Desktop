"""Unified object storage abstraction (local filesystem or S3)."""
from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

_BUCKET_CHAT = "ieeg-chat-uploads"
_ALL_BUCKETS = [_BUCKET_CHAT]


class StorageUnavailableError(RuntimeError):
    """Raised when the object-storage endpoint (S3) is unreachable.

    Carries no traceback noise — the endpoint-down condition is logged once, concisely,
    by StorageService; callers can swallow this without re-logging a full stack.
    """


class StorageService:
    def __init__(
        self,
        backend: Optional[str] = None,
        local_root: Optional[Path] = None,
    ) -> None:
        self._backend = (
            backend
            or os.environ.get("IEEG_STORAGE_BACKEND")
            or os.environ.get("AGENT_STORAGE_BACKEND")
            or "local"
        ).strip().lower()
        self._local_root = local_root
        self._s3_client = None
        self._endpoint_down = False
        if self._backend == "s3":
            self._init_s3_client()
        elif self._backend != "local":
            raise ValueError("IEEG_STORAGE_BACKEND must be 'local' or 's3'")

    def _init_s3_client(self) -> None:
        import boto3
        from botocore.config import Config as BotoConfig

        # The SDK resolves credentials and region from its standard provider chain.
        self._s3_client = boto3.client(
            "s3",
            endpoint_url=os.environ.get("IEEG_S3_ENDPOINT_URL") or None,
            config=BotoConfig(signature_version="s3v4"),
        )

    def _run_s3(self, op_name: str, fn):
        """Run an S3 operation, collapsing an unreachable endpoint into one concise warning.

        After the first connection failure ``_endpoint_down`` is set and every later S3 call
        short-circuits with StorageUnavailableError (no botocore traceback, no per-turn spam).
        Normal botocore ClientError/other exceptions are re-raised so callers handle them as before.
        """
        from botocore.exceptions import ConnectionError as BotoConnectionError

        if getattr(self, "_endpoint_down", False):
            raise StorageUnavailableError(f"object storage endpoint unavailable (skipping {op_name})")
        try:
            return fn()
        except BotoConnectionError as exc:
            self._endpoint_down = True
            logger.warning(
                "[Storage] Object storage endpoint unreachable; disabling storage for this process "
                "(further attempts will be skipped silently). %s: %s",
                op_name,
                exc.__class__.__name__,
            )
            raise StorageUnavailableError(str(exc)) from None

    def _local_dir(self) -> Path:
        if self._local_root:
            return self._local_root
        configured = os.environ.get("IEEG_STORAGE_LOCAL_ROOT") or os.environ.get("AGENT_STORAGE_LOCAL_ROOT")
        if configured:
            return Path(configured).expanduser()
        return Path(__file__).resolve().parents[2] / "data" / "storage"

    def _local_bucket(self, bucket: str) -> Path:
        root = self._local_dir().resolve()
        directory = (root / bucket).resolve()
        if not bucket or Path(bucket).name != bucket or directory.parent != root:
            raise ValueError("Invalid storage bucket")
        return directory

    def _local_path(self, bucket: str, key: str) -> Path:
        directory = self._local_bucket(bucket)
        path = (directory / key).resolve()
        if directory not in path.parents:
            raise ValueError("Invalid storage key")
        return path

    @property
    def backend_name(self) -> str:
        return self._backend

    def ensure_bucket(self, bucket: str) -> None:
        if self._backend == "local":
            self._local_bucket(bucket).mkdir(parents=True, exist_ok=True)
            return
        from botocore.exceptions import ClientError

        def _ensure():
            try:
                self._s3_client.head_bucket(Bucket=bucket)
            except ClientError:
                try:
                    self._s3_client.create_bucket(Bucket=bucket)
                    logger.info("[Storage] Created bucket: %s", bucket)
                except ClientError:
                    logger.warning("[Storage] Failed to create bucket %s — will retry on first use", bucket, exc_info=True)

        self._run_s3(f"ensure_bucket({bucket})", _ensure)

    def ensure_default_buckets(self) -> None:
        for bucket in _ALL_BUCKETS:
            try:
                self.ensure_bucket(bucket)
            except Exception:
                logger.warning("[Storage] Bucket ensure failed for %s, continuing startup", bucket, exc_info=True)

    def put_object(self, bucket: str, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        if self._backend == "local":
            path = self._local_path(bucket, key)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
            return key
        self._run_s3(
            f"put_object({bucket})",
            lambda: self._s3_client.put_object(
                Bucket=bucket, Key=key, Body=data, ContentType=content_type,
            ),
        )
        return key

    def get_object(self, bucket: str, key: str) -> Optional[bytes]:
        if self._backend == "local":
            path = self._local_path(bucket, key)
            if not path.exists():
                return None
            return path.read_bytes()
        from botocore.exceptions import ClientError

        def _get():
            try:
                resp = self._s3_client.get_object(Bucket=bucket, Key=key)
                return resp["Body"].read()
            except ClientError:
                return None

        try:
            return self._run_s3(f"get_object({bucket})", _get)
        except StorageUnavailableError:
            return None

    def get_presigned_url(self, bucket: str, key: str, expires_seconds: int = 3600) -> str:
        default_expires = int((os.environ.get("IEEG_PRESIGNED_URL_EXPIRES") or os.environ.get("AGENT_PRESIGNED_URL_EXPIRES") or "3600"))
        if expires_seconds <= 0:
            expires_seconds = default_expires
        if self._backend == "local":
            return f"/local-storage/{bucket}/{key}"
        return self._run_s3(
            f"get_presigned_url({bucket})",
            lambda: self._s3_client.generate_presigned_url(
                "get_object",
                Params={"Bucket": bucket, "Key": key},
                ExpiresIn=expires_seconds,
            ),
        )

    def delete_object(self, bucket: str, key: str) -> bool:
        if self._backend == "local":
            path = self._local_path(bucket, key)
            if path.exists():
                path.unlink()
                return True
            return False
        from botocore.exceptions import ClientError

        def _delete():
            try:
                self._s3_client.delete_object(Bucket=bucket, Key=key)
                return True
            except ClientError:
                return False

        try:
            return self._run_s3(f"delete_object({bucket})", _delete)
        except StorageUnavailableError:
            return False

    def object_exists(self, bucket: str, key: str) -> bool:
        if self._backend == "local":
            return self._local_path(bucket, key).exists()
        from botocore.exceptions import ClientError

        def _exists():
            try:
                self._s3_client.head_object(Bucket=bucket, Key=key)
                return True
            except ClientError:
                return False

        try:
            return self._run_s3(f"object_exists({bucket})", _exists)
        except StorageUnavailableError:
            return False


_storage_service: Optional[StorageService] = None


def get_storage_service() -> StorageService:
    global _storage_service
    if _storage_service is None:
        _storage_service = StorageService()
        _storage_service.ensure_default_buckets()
    return _storage_service


def reset_storage_for_tests() -> None:
    global _storage_service
    _storage_service = None
