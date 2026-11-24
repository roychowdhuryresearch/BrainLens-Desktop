from __future__ import annotations

import hashlib
import logging
import re
from pathlib import PurePath
from typing import Any, Mapping


_SECRET_KEYS = {
    "authorization", "auth", "bearer", "token", "accesstoken", "refreshtoken",
    "idtoken", "sessiontoken", "apikey", "xapikey", "secret", "clientsecret",
    "credential", "credentials", "password", "passwd", "privatekey", "signingkey",
    "jwt", "cookie", "setcookie",
}
_CLINICAL_ID_KEYS = {
    "patient", "patientid", "patientidentifier", "patientnumber", "patientname",
    "subjectid", "subjectidentifier", "subjectname", "participantid",
    "participantidentifier", "participantname", "mrn", "medicalrecordnumber",
    "medicalrecordid", "dob", "dateofbirth", "email", "emailaddress",
    "phone", "phonenumber", "telephone", "accession", "accessionid",
    "accessionnumber", "caseid", "caseidentifier", "casenumber", "address",
    "streetaddress", "homeaddress", "postaladdress",
}
_PATH_KEYS = {
    "path", "filepath", "filename", "file", "recordingpath", "recordingfile",
    "inputpath", "inputfile", "outputpath", "outputfile", "artifactpath",
    "directory", "folder",
}
_SAFE_SENSITIVE_ALIAS_KEYS = {
    "tokencount", "inputtokencount", "outputtokencount", "totaltokencount",
    "patientcount", "subjectcount", "participantcount", "filecount", "pathcount",
}
_SECRET_KEY_TOKENS = {
    "authorization", "auth", "bearer", "token", "secret", "credential",
    "credentials", "password", "passwd", "privatekey", "signingkey", "jwt",
    "cookie", "setcookie",
}
_SECRET_KEY_COMPOUNDS = {
    "accesstoken", "refreshtoken", "idtoken", "sessiontoken", "apikey",
    "clientsecret", "privatekey", "signingkey",
}
_CLINICAL_KEY_TOKENS = {
    "patient", "subject", "participant", "mrn", "dob", "email", "phone",
    "telephone", "accession", "address",
}
_CLINICAL_KEY_COMPOUNDS = {
    "patientid", "patientidentifier", "patientnumber", "patientname",
    "subjectid", "subjectidentifier", "subjectname", "participantid",
    "participantidentifier", "participantname", "medicalrecordnumber",
    "medicalrecordid", "dateofbirth", "emailaddress", "phonenumber",
    "accessionid", "accessionnumber", "caseid", "caseidentifier", "casenumber",
    "streetaddress", "homeaddress", "postaladdress",
}
_PATH_KEY_TOKENS = {"path", "file", "filename", "directory", "folder"}
_PATH_KEY_COMPOUNDS = {
    "filepath", "recordingpath", "recordingfile", "inputpath", "inputfile",
    "outputpath", "outputfile", "artifactpath",
}
_POSIX_PATH_RE = re.compile(r"(?<![A-Za-z0-9:/])/(?:[^\s/]+/)+[^\s]+")
_WINDOWS_PATH_RE = re.compile(r"\b[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s]+")
_SPACED_POSIX_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9:/])/(?:Users|home|private|tmp|var|Volumes|mnt|opt|data|srv)"
    r"(?:/[^/\r\n'\"<>|,;]+){2,}",
    re.IGNORECASE,
)
_SPACED_WINDOWS_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9])\b[A-Za-z]:\\(?:Users|Documents and Settings|ProgramData|Temp|data)"
    r"(?:\\[^\\\r\n'\"<>|,;]+){2,}",
    re.IGNORECASE,
)
_SPACED_FILE_URI_RE = re.compile(
    r"\bfile://(?:localhost)?/(?:Users|home|private|tmp|var|Volumes|mnt|opt|data|srv)"
    r"(?:/[^/\r\n'\"<>|,;]+){2,}",
    re.IGNORECASE,
)
_FILE_URI_RE = re.compile(
    r"\bfile://(?:localhost)?(?:/[^\s'\"<>]+)+",
    re.IGNORECASE,
)
_QUOTED_PATH_RE = re.compile(
    r"(?P<quote>['\"])(?P<path>/(?!/)[^'\"\r\n]+|[A-Za-z]:\\[^'\"\r\n]+)(?P=quote)"
)
_CLINICAL_FILE_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9:/])/(?!/)[^\r\n]{1,500}?\.(?:edf|bdf|fif|set|vhdr|eeg|nwb|mat|csv|tsv|xlsx|pdf|json|png|jpe?g)\b",
    re.IGNORECASE,
)
_RELATIVE_CLINICAL_FILE_PATH_RE = re.compile(
    r"(?<![A-Za-z0-9.:/\\])(?:\.{1,2}[\\/])?"
    r"(?:[^\s'\"\\/]+[\\/]){1,16}[^\s'\"\\/]+"
    r"\.(?:edf|bdf|fif|set|vhdr|eeg|nwb|mat|csv|tsv|xlsx|pdf|json|png|jpe?g)\b",
    re.IGNORECASE,
)
_UNC_CLINICAL_FILE_PATH_RE = re.compile(
    r"\\\\[^\s'\"\\]+(?:\\[^\s'\"\\]+)+"
    r"\.(?:edf|bdf|fif|set|vhdr|eeg|nwb|mat|csv|tsv|xlsx|pdf|json|png|jpe?g)\b",
    re.IGNORECASE,
)
_BEARER_RE = re.compile(r"\bBearer\s+[^\s,;]+", re.IGNORECASE)
_SECRET_TOKEN_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    r"sk-(?:proj-)?[A-Za-z0-9_-]{8,}"
    r"|gh[pousr]_[A-Za-z0-9]{16,}"
    r"|AKIA[A-Z0-9]{12,}"
    r"|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"
    r")(?![A-Za-z0-9])"
)
_INLINE_SECRET_RE = re.compile(
    r"\b(api[ _-]?key|access[ _-]?token|refresh[ _-]?token|id[ _-]?token|"
    r"session[ _-]?token|token|client[ _-]?secret|secret|credentials?|password|passwd|"
    r"private[ _-]?key|signing[ _-]?key)\b\s*[:=]\s*[^\s,;]+",
    re.IGNORECASE,
)
_INLINE_CLINICAL_ID_RE = re.compile(
    r"\b(MRN|medical[ _-]?record[ _-]?(?:number|id)|"
    r"patient(?:[ _-]?(?:id|identifier|number|name))?|"
    r"subject[ _-]?(?:id|identifier|name)|participant[ _-]?(?:id|identifier|name)|"
    r"date[ _-]?of[ _-]?birth|DOB|accession(?:[ _-]?(?:id|number))?|"
    r"case[ _-]?(?:id|identifier|number)|email(?:[ _-]?address)?|"
    r"phone(?:[ _-]?number)?|telephone|address)\b\s*[:=#-]?\s*"
    r"[A-Za-z0-9_.@+() -]{3,120}",
    re.IGNORECASE,
)
_EMAIL_RE = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b", re.IGNORECASE)
_PHONE_RE = re.compile(
    r"(?<!\d)(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}(?!\d)"
)
_ADDRESS_RE = re.compile(
    r"\b\d{1,6}\s+[A-Za-z0-9.' -]{2,60}\s+"
    r"(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Highway|Hwy)\b",
    re.IGNORECASE,
)


def _path_reference(value: Any) -> str:
    raw = str(value or "")
    suffix = PurePath(raw.replace("\\", "/")).suffix[:12]
    digest = hashlib.sha256(raw.encode("utf-8", errors="replace")).hexdigest()[:12]
    return f"artifact:{digest}{suffix}"


def _normalize_key(key: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(key or "").lower())


def _key_tokens(key: str) -> tuple[str, ...]:
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", str(key or ""))
    return tuple(
        token
        for token in re.split(r"[^a-z0-9]+", separated.lower())
        if token
    )


def _sensitive_key_kind(key: str) -> str | None:
    normalized = _normalize_key(key)
    if normalized in _SAFE_SENSITIVE_ALIAS_KEYS:
        return None
    tokens = _key_tokens(key)
    if tokens and tokens[-1] in {"sha256", "digest", "hash"}:
        return None
    if tokens and tokens[-1] in {"count", "total", "usage", "limit"}:
        return None
    joined = "".join(tokens)
    if normalized in _SECRET_KEYS or any(token in _SECRET_KEY_TOKENS for token in tokens):
        return "secret"
    if any(compound in joined for compound in _SECRET_KEY_COMPOUNDS):
        return "secret"
    if normalized in _CLINICAL_ID_KEYS or any(token in _CLINICAL_KEY_TOKENS for token in tokens):
        return "clinical"
    if any(compound in joined for compound in _CLINICAL_KEY_COMPOUNDS):
        return "clinical"
    if normalized in _PATH_KEYS or any(token in _PATH_KEY_TOKENS for token in tokens):
        return "path"
    if any(compound in joined for compound in _PATH_KEY_COMPOUNDS):
        return "path"
    return None


def _redact_string(value: str) -> str:
    def quoted_path(match: re.Match[str]) -> str:
        quote = match.group("quote")
        return f"{quote}{_path_reference(match.group('path'))}{quote}"

    redacted = _SPACED_FILE_URI_RE.sub(lambda match: _path_reference(match.group(0)), value)
    redacted = _FILE_URI_RE.sub(lambda match: _path_reference(match.group(0)), redacted)
    redacted = _QUOTED_PATH_RE.sub(quoted_path, redacted)
    redacted = _SPACED_POSIX_PATH_RE.sub(lambda match: _path_reference(match.group(0)), redacted)
    redacted = _SPACED_WINDOWS_PATH_RE.sub(lambda match: _path_reference(match.group(0)), redacted)
    redacted = _UNC_CLINICAL_FILE_PATH_RE.sub(lambda match: _path_reference(match.group(0)), redacted)
    redacted = _RELATIVE_CLINICAL_FILE_PATH_RE.sub(lambda match: _path_reference(match.group(0)), redacted)
    redacted = _CLINICAL_FILE_PATH_RE.sub(lambda match: _path_reference(match.group(0)), redacted)
    redacted = _POSIX_PATH_RE.sub(lambda match: _path_reference(match.group(0)), redacted)
    redacted = _WINDOWS_PATH_RE.sub(lambda match: _path_reference(match.group(0)), redacted)
    redacted = _BEARER_RE.sub("Bearer [REDACTED-SECRET]", redacted)
    redacted = _SECRET_TOKEN_RE.sub("[REDACTED-SECRET]", redacted)
    redacted = _INLINE_SECRET_RE.sub(lambda match: f"{match.group(1)}=[REDACTED-SECRET]", redacted)
    redacted = _EMAIL_RE.sub("[REDACTED-CLINICAL]", redacted)
    redacted = _PHONE_RE.sub("[REDACTED-CLINICAL]", redacted)
    redacted = _ADDRESS_RE.sub("[REDACTED-CLINICAL]", redacted)
    return _INLINE_CLINICAL_ID_RE.sub(
        lambda match: f"{match.group(1)}=[REDACTED-CLINICAL]",
        redacted,
    )


def redact_observability_payload(value: Any, *, key: str = "") -> Any:
    """Redact structured secrets, clinical identifiers, and raw local paths."""

    sensitive_kind = _sensitive_key_kind(key)
    if sensitive_kind == "secret":
        return "[REDACTED-SECRET]"
    if sensitive_kind == "clinical":
        return "[REDACTED-CLINICAL]"
    if sensitive_kind == "path":
        return _path_reference(value)
    if isinstance(value, Mapping):
        return {
            str(item_key): redact_observability_payload(item_value, key=str(item_key))
            for item_key, item_value in value.items()
        }
    if isinstance(value, list):
        return [redact_observability_payload(item) for item in value]
    if isinstance(value, tuple):
        return tuple(redact_observability_payload(item) for item in value)
    if isinstance(value, str):
        return _redact_string(value)
    return value


def redact_observability_text(value: Any) -> str:
    return str(redact_observability_payload(str(value or "")))


class ObservabilityRedactionFilter(logging.Filter):
    """Last-mile filter for file loggers that may receive preformatted text."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_observability_text(record.msg)
        else:
            record.msg = redact_observability_payload(record.msg)
        if isinstance(record.args, Mapping):
            record.args = redact_observability_payload(record.args)
        elif isinstance(record.args, tuple):
            record.args = tuple(redact_observability_payload(item) for item in record.args)
        return True
