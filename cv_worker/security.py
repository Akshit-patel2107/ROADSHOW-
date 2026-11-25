"""
ROADSHADOW 2.0 — CV Worker Security & Network Validation Utilities
Enforces constant-time bearer API key validation, SSRF-safe URL/RTSP checks,
DNS resolution checks against private/loopback/metadata IP ranges, and secret scrubbing.
"""

from urllib.parse import urlparse, urlunparse
import hmac
import ipaddress
import re
import socket
from typing import Optional, Sequence, Tuple


BLOCKED_HOSTNAMES = {
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "metadata",
    "instance-data",
}

SAFE_ID_RE = re.compile(r"[^a-zA-Z0-9_\-]")


def verify_bearer_token(authorization_header: Optional[str], expected_api_key: str) -> bool:
    """Constant-time bearer token check. If expected_api_key is empty, auth is open (dev only)."""
    key = (expected_api_key or "").strip()
    if not key:
        return True
    if not authorization_header or not authorization_header.startswith("Bearer "):
        return False
    provided = authorization_header[7:].strip()
    if not provided:
        return False
    return hmac.compare_digest(provided.encode("utf-8"), key.encode("utf-8"))


def sanitize_identifier(raw: str, fallback: str = "item", max_len: int = 128) -> str:
    cleaned = SAFE_ID_RE.sub("_", (raw or "").strip())
    cleaned = cleaned.strip("_")
    if not cleaned:
        cleaned = fallback
    return cleaned[:max_len]


def _is_ip_blocked(ip_str: str) -> bool:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return False
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_remote_url(
    url: str,
    allowed_schemes: Sequence[str],
    resolve_dns: bool = True,
) -> Tuple[bool, Optional[str]]:
    """
    Validate a remote HTTP(S) or RTSP(S) URL against SSRF targets:
    - Restricts scheme strictly to allowed_schemes (blocks file://, local paths, etc.)
    - Rejects localhost, .local, .internal, cloud metadata hosts, and private/loopback/link-local IPs
    - Optionally resolves DNS to prevent DNS rebinding to private IPs
    """
    raw = (url or "").strip()
    if not raw or len(raw) > 2048:
        return False, "URL is empty or exceeds maximum length."

    parsed = urlparse(raw)
    scheme = (parsed.scheme or "").lower()
    if scheme not in allowed_schemes:
        return False, f"URL scheme '{scheme or 'none'}' is not permitted."

    host = (parsed.hostname or "").strip().lower()
    if not host:
        return False, "URL must include a valid hostname."

    if host in BLOCKED_HOSTNAMES or host.endswith(".local") or host.endswith(".internal"):
        return False, "Loopback, local, or internal metadata hostnames are blocked by security policy."

    if _is_ip_blocked(host):
        return False, "Private, loopback, or link-local IP addresses are blocked by security policy."

    if resolve_dns:
        try:
            infos = socket.getaddrinfo(host, parsed.port or (554 if scheme.startswith("rtsp") else 443))
            for info in infos:
                sockaddr = info[4]
                if sockaddr and _is_ip_blocked(str(sockaddr[0])):
                    return False, "Target hostname resolves to a private, loopback, or link-local IP address."
        except socket.gaierror:
            # Let downstream connection report host-unreachable cleanly without leaking internals
            pass

    return True, None


def scrub_url_credentials(url: str) -> str:
    """Strip username/password from URLs before writing to logs or error messages."""
    try:
        parsed = urlparse(url)
        if parsed.username or parsed.password:
            host = parsed.hostname or ""
            netloc = f"{host}:{parsed.port}" if parsed.port else host
            return urlunparse((parsed.scheme, netloc, parsed.path, parsed.params, "", ""))
    except Exception:
        pass
    return url
