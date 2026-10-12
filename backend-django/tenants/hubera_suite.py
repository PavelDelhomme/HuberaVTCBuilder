"""
Pont cookie suite Hubera (Cloudity) → session Press / VTCBuilder (SimpleJWT).
Ne jamais accepter un refresh token comme access.
"""
from __future__ import annotations

import base64
import json
import logging
from typing import Any, TypedDict
from urllib.parse import unquote

logger = logging.getLogger(__name__)

HUBERA_SUITE_COOKIE = 'hubera_suite_auth'


class SuiteAuthState(TypedDict, total=False):
    accessToken: str | None
    refreshToken: str | None
    tenantId: int | None
    email: str | None


def _b64url_decode(segment: str) -> bytes | None:
    try:
        padded = segment + '=' * (-len(segment) % 4)
        return base64.urlsafe_b64decode(padded.encode('ascii'))
    except Exception:
        return None


def jwt_token_type(token: str | None) -> str | None:
    if not token or not isinstance(token, str):
        return None
    parts = token.split('.')
    if len(parts) < 2:
        return None
    raw = _b64url_decode(parts[1])
    if raw is None:
        return None
    try:
        payload = json.loads(raw.decode('utf-8'))
    except Exception:
        return None
    token_type = payload.get('token_type')
    if token_type in ('access', 'refresh'):
        return token_type
    return None


def is_press_access_token(token: str | None) -> bool:
    """True si le JWT ressemble à un access SimpleJWT Press (pas Cloudity)."""
    if not token:
        return False
    if jwt_token_type(token) == 'refresh':
        return False
    if jwt_token_type(token) == 'access':
        return True
    parts = token.split('.')
    if len(parts) != 3:
        return False
    raw = _b64url_decode(parts[1])
    if raw is None:
        return False
    try:
        payload = json.loads(raw.decode('utf-8'))
    except Exception:
        return False
    return 'user_id' in payload


def normalize_suite_tokens(
    access_token: str | None, refresh_token: str | None
) -> tuple[str | None, str | None]:
    """Corrige un éventuel swap access/refresh dans le cookie suite."""
    access = (access_token or '').strip() or None
    refresh = (refresh_token or '').strip() or None

    access_kind = jwt_token_type(access)
    refresh_kind = jwt_token_type(refresh)

    if access_kind == 'refresh' and refresh_kind == 'access':
        access, refresh = refresh, access
        access_kind, refresh_kind = refresh_kind, access_kind

    if access_kind == 'refresh':
        if not refresh:
            refresh = access
        access = None

    if refresh_kind == 'access' and not access:
        access = refresh
        refresh = None

    return access, refresh


def parse_suite_auth_cookie(raw: str | None) -> SuiteAuthState | None:
    if not raw:
        return None
    try:
        decoded = unquote(raw)
        data = json.loads(decoded)
    except Exception:
        logger.debug('hubera_suite: cookie illisible')
        return None
    if not isinstance(data, dict):
        return None
    access, refresh = normalize_suite_tokens(
        data.get('accessToken'), data.get('refreshToken')
    )
    email = data.get('email')
    tenant_id = data.get('tenantId')
    if not access and not refresh and not email:
        return None
    return SuiteAuthState(
        accessToken=access,
        refreshToken=refresh,
        tenantId=tenant_id if isinstance(tenant_id, int) else None,
        email=str(email).strip() if email else None,
    )


def read_suite_auth_from_request(request) -> SuiteAuthState | None:
    raw = request.COOKIES.get(HUBERA_SUITE_COOKIE)
    if not raw:
        return None
    return parse_suite_auth_cookie(raw)


def suite_session_usable(state: SuiteAuthState | None) -> bool:
    """Cookie suite présent avec email + au moins un jeton (access ou refresh Cloudity)."""
    if not state:
        return False
    email = (state.get('email') or '').strip()
    if not email:
        return False
    return bool(state.get('accessToken') or state.get('refreshToken'))
