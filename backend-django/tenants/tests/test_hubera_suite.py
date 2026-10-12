import base64
import json
from urllib.parse import quote

from django.test import RequestFactory

from tenants.hubera_suite import (
    HUBERA_SUITE_COOKIE,
    jwt_token_type,
    normalize_suite_tokens,
    parse_suite_auth_cookie,
    read_suite_auth_from_request,
    suite_session_usable,
)


def _b64url_obj(obj: dict) -> str:
    raw = json.dumps(obj, separators=(',', ':')).encode('utf-8')
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _fake_jwt(token_type: str) -> str:
    header = _b64url_obj({'alg': 'none', 'typ': 'JWT'})
    payload = _b64url_obj({'token_type': token_type, 'user_id': 1, 'exp': 9999999999})
    return f'{header}.{payload}.sig'


def test_normalize_suite_tokens_swaps_when_inverted():
    access = _fake_jwt('refresh')
    refresh = _fake_jwt('access')
    norm_access, norm_refresh = normalize_suite_tokens(access, refresh)
    assert jwt_token_type(norm_access) == 'access'
    assert jwt_token_type(norm_refresh) == 'refresh'


def test_parse_suite_auth_cookie():
    payload = {
        'accessToken': _fake_jwt('access'),
        'refreshToken': _fake_jwt('refresh'),
        'email': 'paul@example.com',
        'tenantId': 1,
    }
    state = parse_suite_auth_cookie(json.dumps(payload))
    assert state is not None
    assert state['email'] == 'paul@example.com'
    assert jwt_token_type(state['accessToken']) == 'access'


def test_read_suite_auth_from_request():
    payload = {
        'accessToken': _fake_jwt('access'),
        'email': 'a@b.c',
    }
    factory = RequestFactory()
    request = factory.post('/api/auth/suite-bridge/')
    request.COOKIES[HUBERA_SUITE_COOKIE] = quote(json.dumps(payload))
    state = read_suite_auth_from_request(request)
    assert suite_session_usable(state) is True
