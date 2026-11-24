"""Fail-closed ownership, contract-impact, and executable-proof gate."""

from .audit import AuditResult, audit_change_set, load_registry

__all__ = ["AuditResult", "audit_change_set", "load_registry"]
