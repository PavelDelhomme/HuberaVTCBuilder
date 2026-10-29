/** URL publique d’une landing Hubera. L’app métier n’est pas servie par l’éditeur. */

export function huberaLandingUrl(
  project: { domain?: string | null; metadata?: Record<string, unknown> | null } | null | undefined,
  pageSlug?: string | null,
): string | null {
  if (!project || project.metadata?.kind !== 'hubera-product-landing') return null
  const domain = (project.domain || '').trim()
  if (!domain.endsWith('hubera.cloud')) return null
  const slug = (pageSlug || 'home').replace(/^\/+/, '')
  const path = slug === '' || slug === 'home' || slug === 'accueil' ? '/' : `/${slug}`
  return `https://${domain}${path}`
}
