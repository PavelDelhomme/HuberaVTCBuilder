import { huberaLandingUrl } from '@/lib/huberaLandingUrl'

describe('huberaLandingUrl', () => {
  const music = {
    domain: 'music.hubera.cloud',
    metadata: { kind: 'hubera-product-landing' },
  }

  it('ouvre la landing sur le domaine du catalogue', () => {
    expect(huberaLandingUrl({ domain: 'hubera.cloud', metadata: { kind: 'hubera-product-landing' } }, 'home')).toBe(
      'https://hubera.cloud/',
    )
    expect(huberaLandingUrl(music, 'tarifs')).toBe('https://music.hubera.cloud/tarifs')
  })

  it('ignore un projet qui n’est pas une landing Hubera', () => {
    expect(huberaLandingUrl({ domain: 'music.hubera.cloud', metadata: { kind: 'vtc' } }, 'home')).toBeNull()
    expect(huberaLandingUrl({ domain: 'evil.example', metadata: { kind: 'hubera-product-landing' } }, 'home')).toBeNull()
  })
})
