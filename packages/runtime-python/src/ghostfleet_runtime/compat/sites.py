"""Optional legacy Sites handoff gate with exact deployment URL binding."""
from urllib.parse import urlsplit

def sites_handoff_headers(*, url, expected_url, token, site_token):
    parsed = urlsplit(url)
    if url != expected_url or parsed.scheme != "https" or not parsed.hostname or not parsed.hostname.endswith(".chatgpt.site") or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path != "/api/enrollment/handoff":
        raise ValueError("HANDOFF_SITE_PROFILE_MISMATCH")
    if not isinstance(site_token, str) or not 32 <= len(site_token) <= 4096 or any(ch.isspace() for ch in site_token):
        raise ValueError("HANDOFF_SITE_AUTH_REQUIRED")
    return {"authorization": "Bearer " + token, "content-type": "application/json", "oai-sites-authorization": "Bearer " + site_token}
