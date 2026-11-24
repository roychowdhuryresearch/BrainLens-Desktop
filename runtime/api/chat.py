import base64
import io
import logging
from typing import Dict, List, Optional

from runtime.agent_runtime.attachment_store import get_attachment_store
from runtime.agent_runtime.image_reference_store import ImageReferenceStore
from runtime.models.schemas import AttachmentData, ImageData

logger = logging.getLogger(__name__)

_image_stores: Dict[str, ImageReferenceStore] = {}


def get_image_store(conversation_id: str) -> ImageReferenceStore:
    if conversation_id not in _image_stores:
        _image_stores[conversation_id] = ImageReferenceStore(conversation_id=conversation_id)
    return _image_stores[conversation_id]


def _decode_base64(data_b64: str) -> bytes:
    payload = data_b64.split(",", 1)[-1] if "," in data_b64 else data_b64
    return base64.b64decode(payload)


def _extract_pdf_text(data_b64: str) -> str:
    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(_decode_base64(data_b64)))
        pages = []
        for index, page in enumerate(reader.pages):
            text = page.extract_text() or ""
            if text.strip():
                pages.append(f"--- Page {index + 1} ---\n{text.strip()}")
        return "\n\n".join(pages) if pages else "(PDF has no extractable text)"
    except Exception as exc:
        logger.warning("PDF text extraction failed: %s", exc)
        return f"(PDF text extraction failed: {exc})"


def _extract_xlsx_text(data_b64: str) -> str:
    try:
        import openpyxl

        wb = openpyxl.load_workbook(io.BytesIO(_decode_base64(data_b64)), read_only=True, data_only=True)
        parts = []
        for ws in wb.worksheets[:5]:
            rows = []
            for row in ws.iter_rows(max_row=50, values_only=True):
                rows.append("\t".join(str(cell) if cell is not None else "" for cell in row))
            if rows:
                parts.append(f"[Sheet: {ws.title}]\n" + "\n".join(rows))
        wb.close()
        return "\n\n".join(parts) if parts else "(Excel has no data)"
    except Exception as exc:
        logger.warning("Excel extraction failed: %s", exc)
        return f"(Excel extraction failed: {exc})"


def _extract_docx_text(data_b64: str) -> str:
    try:
        from docx import Document

        doc = Document(io.BytesIO(_decode_base64(data_b64)))
        paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
        return "\n".join(paragraphs) if paragraphs else "(Word document has no text)"
    except Exception as exc:
        logger.warning("Word extraction failed: %s", exc)
        return f"(Word extraction failed: {exc})"


def _extract_plain_text(data_b64: str) -> str:
    try:
        raw = _decode_base64(data_b64)
    except Exception as exc:
        logger.warning("Plain text base64 decode failed: %s", exc)
        return f"(Text file decode failed: {exc})"
    for encoding in ("utf-8", "gbk", "gb18030"):
        try:
            text = raw.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    else:
        text = raw.decode("utf-8", errors="replace")
    return text.strip() or "(Text file is empty)"


def _extract_pptx_text(data_b64: str) -> str:
    try:
        from pptx import Presentation

        prs = Presentation(io.BytesIO(_decode_base64(data_b64)))
        parts = []
        for index, slide in enumerate(prs.slides):
            texts = []
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for para in shape.text_frame.paragraphs:
                        text = para.text.strip()
                        if text:
                            texts.append(text)
            if texts:
                parts.append(f"--- Slide {index + 1} ---\n" + "\n".join(texts))
        return "\n\n".join(parts) if parts else "(PPT has no text)"
    except Exception as exc:
        logger.warning("PPT extraction failed: %s", exc)
        return f"(PPT extraction failed: {exc})"


_EXTRACTORS = {
    "pdf": _extract_pdf_text,
    "xlsx": _extract_xlsx_text,
    "xls": _extract_xlsx_text,
    "docx": _extract_docx_text,
    "doc": _extract_docx_text,
    "pptx": _extract_pptx_text,
    "ppt": _extract_pptx_text,
    "txt": _extract_plain_text,
    "md": _extract_plain_text,
    "markdown": _extract_plain_text,
}


_DOC_CONTENT_TYPES = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/vnd.ms-excel": "xlsx",
    "application/msword": "docx",
    "application/vnd.ms-powerpoint": "pptx",
    "text/plain": "txt",
    "text/markdown": "md",
    "text/x-markdown": "md",
}


def _get_file_ext(attachment: AttachmentData) -> Optional[str]:
    content_type = (attachment.content_type or "").lower().split(";", 1)[0].strip()
    ext = _DOC_CONTENT_TYPES.get(content_type)
    if ext is None and attachment.filename and "." in attachment.filename:
        suffix = attachment.filename.rsplit(".", 1)[-1].lower()
        if suffix in _EXTRACTORS:
            ext = suffix
    return ext


def _load_attachment_bytes(attachment: AttachmentData) -> Optional[bytes]:
    if attachment.data:
        return _decode_base64(attachment.data)
    storage_key = (attachment.storage_key or "").strip()
    if storage_key and "/" in storage_key:
        bucket, object_key = storage_key.split("/", 1)
        from runtime.services.storage_service import get_storage_service

        return get_storage_service().get_object(bucket, object_key)
    return None


def process_uploaded_attachments(
    conversation_id: str,
    attachments: Optional[List[AttachmentData]],
    *,
    message_id: str = "message",
    user_id: Optional[str] = None,
) -> tuple:
    """Persist uploaded attachments and expose references for tool routing.

    This intentionally does not parse PDFs or run VL before the model decides
    which tool to call. Attachment content extraction happens through built-in tools.
    """
    if not attachments:
        return None, []

    attachment_store = get_attachment_store(conversation_id)
    image_store = get_image_store(conversation_id)
    persisted_refs: list[str] = []
    attachment_urls: list[dict] = []

    for item in attachments:
        try:
            raw = _load_attachment_bytes(item)
        except Exception:
            logger.warning("[Attachment] failed to load uploaded bytes", exc_info=True)
            raw = None
        if raw is None:
            logger.warning(
                "[Attachment] skipped attachment without bytes: filename=%s storage_key=%s",
                item.filename,
                item.storage_key,
            )
            continue

        ref = attachment_store.store_upload(
            raw=raw,
            content_type=item.content_type,
            filename=item.filename,
            message_id=message_id,
            user_id=user_id,
            size=item.size,
            sha256=item.sha256,
        )

        if ref.content_type.lower().startswith("image/"):
            image_ref = image_store.store_existing_object(
                bucket=ref.bucket,
                object_key=ref.object_key,
                content_type=ref.content_type,
                filename=ref.filename,
                description=f"attachment {ref.attachment_id}",
            )
            ref.image_ref = image_ref.ref_id
            attachment_store.update(ref)

        persisted_refs.append(ref.attachment_id)
        try:
            from runtime.services.storage_service import get_storage_service

            attachment_urls.append({
                "url": get_storage_service().get_presigned_url(ref.bucket, ref.object_key),
                "storage_key": f"{ref.bucket}/{ref.object_key}",
                "content_type": ref.content_type,
                "filename": ref.filename,
                "attachment_ref": ref.attachment_id,
                "image_ref": ref.image_ref,
            })
        except Exception:
            logger.warning("Failed to generate presigned URL for %s", ref.object_key, exc_info=True)

    return attachment_store.get_summary(persisted_refs), attachment_urls


def process_uploaded_images(
    conversation_id: str,
    images: Optional[List[ImageData]],
) -> tuple:
    """Deprecated compatibility wrapper. New requests use attachments."""
    return process_uploaded_attachments(conversation_id, images, message_id="legacy")


def build_attachment_hint(attachments: Optional[List[AttachmentData]]) -> str:
    if not attachments:
        return ""
    parts: list[str] = []
    for item in attachments:
        ext = _get_file_ext(item)
        if ext:
            name = item.filename or f"unnamed.{ext}"
            parts.append(f"{name} ({ext})")
    if not parts:
        return ""
    return f"[User uploaded attachments: {', '.join(parts)}]"


def build_file_hint(images: Optional[List[ImageData]]) -> str:
    """Deprecated compatibility wrapper."""
    return build_attachment_hint(images)
