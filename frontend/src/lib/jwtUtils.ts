export function getJwtPayloadExpMs(token: string): number | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4
    if (pad === 2) b64 += '=='
    else if (pad === 3) b64 += '='
    else if (pad === 1) return null
    const json = atob(b64)
    const payload = JSON.parse(json) as { exp?: unknown }
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null
  } catch {
    return null
  }
}

export function jwtTokenType(token: string | null): 'access' | 'refresh' | null {
  if (!token) return null
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = b64.length % 4
    if (pad === 2) b64 += '=='
    else if (pad === 3) b64 += '='
    else if (pad === 1) return null
    const payload = JSON.parse(atob(b64)) as { token_type?: unknown }
    if (payload.token_type === 'access' || payload.token_type === 'refresh') {
      return payload.token_type
    }
  } catch {
    /* ignore */
  }
  return null
}

export function isAccessTokenUsable(token: string | null, skewMs = 90_000): boolean {
  if (!token) return false
  if (jwtTokenType(token) === 'refresh') return false
  const expMs = getJwtPayloadExpMs(token)
  if (expMs == null) return jwtTokenType(token) !== 'refresh'
  return Date.now() + skewMs < expMs
}
