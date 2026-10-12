import { isAccessTokenUsable, jwtTokenType } from '@/lib/jwtUtils'

export const HUBERA_SUITE_COOKIE = 'hubera_suite_auth'

export type SuiteAuthState = {
  accessToken: string | null
  refreshToken: string | null
  tenantId: number | null
  email: string | null
}

export function onHuberaCloudHost(): boolean {
  if (typeof window === 'undefined') return false
  const h = window.location.hostname.toLowerCase()
  return h === 'hubera.cloud' || h.endsWith('.hubera.cloud')
}

function normalizeSuiteTokens(
  accessToken: string | null | undefined,
  refreshToken: string | null | undefined
): Pick<SuiteAuthState, 'accessToken' | 'refreshToken'> {
  let access = (accessToken || '').trim() || null
  let refresh = (refreshToken || '').trim() || null

  const accessKind = jwtTokenType(access)
  const refreshKind = jwtTokenType(refresh)

  if (accessKind === 'refresh' && refreshKind === 'access') {
    ;[access, refresh] = [refresh, access]
  } else if (accessKind === 'refresh') {
    if (!refresh) refresh = access
    access = null
  } else if (refreshKind === 'access' && !access) {
    access = refresh
    refresh = null
  }

  return { accessToken: access, refreshToken: refresh }
}

export function parseSuiteAuth(raw: string | null): SuiteAuthState | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw) as Partial<SuiteAuthState> & { tenantId?: number }
    const { accessToken, refreshToken } = normalizeSuiteTokens(
      data.accessToken,
      data.refreshToken
    )
    if (!accessToken && !refreshToken && !data.email) return null
    return {
      accessToken,
      refreshToken,
      tenantId: typeof data.tenantId === 'number' ? data.tenantId : null,
      email: data.email ? String(data.email).trim() : null,
    }
  } catch {
    return null
  }
}

export function readSuiteCookie(): SuiteAuthState | null {
  if (typeof document === 'undefined') return null
  for (const part of document.cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k !== HUBERA_SUITE_COOKIE) continue
    try {
      return parseSuiteAuth(decodeURIComponent(rest.join('=')))
    } catch {
      return null
    }
  }
  return null
}

/**
 * Corrige localStorage si un refresh SimpleJWT a été stocké comme access.
 * Ne copie jamais les JWT Cloudity du cookie suite dans le stockage Press.
 */
export function repairPressTokenStorage(): void {
  if (typeof window === 'undefined') return

  const token = localStorage.getItem('token')
  const refresh = localStorage.getItem('refresh_token')

  if (token && jwtTokenType(token) === 'refresh') {
    if (!refresh) {
      localStorage.setItem('refresh_token', token)
    }
    localStorage.removeItem('token')
  }

  if (token && !isAccessTokenUsable(token) && jwtTokenType(token) !== 'access') {
    const kind = jwtTokenType(token)
    if (kind === 'refresh') {
      if (!refresh) localStorage.setItem('refresh_token', token)
      localStorage.removeItem('token')
    }
  }
}

export function hasUsablePressAccessToken(): boolean {
  repairPressTokenStorage()
  return isAccessTokenUsable(localStorage.getItem('token'))
}
