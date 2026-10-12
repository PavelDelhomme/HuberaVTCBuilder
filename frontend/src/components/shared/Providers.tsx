'use client'

import { useEffect } from 'react'
import { ThemeProvider } from '@/contexts/ThemeContext'
import { FeaturesProvider } from '@/contexts/FeaturesContext'
import AnalyticsProvider from '@/components/shared/AnalyticsProvider'
import { ReconnectProvider, useReconnect } from '@/contexts/ReconnectContext'
import authService from '@/services/auth.service'

function ProvidersContent({ children }: { children: React.ReactNode }) {
  const { showReconnectModal } = useReconnect()

  useEffect(() => {
    authService.repairTokenStorage()

    // Exposer la fonction pour que l'intercepteur API puisse l'appeler
    if (typeof window !== 'undefined') {
      window.__showReconnectModal = showReconnectModal
    }

    return () => {
      if (typeof window !== 'undefined') {
        delete window.__showReconnectModal
      }
    }
  }, [showReconnectModal])

  return (
    <ThemeProvider>
      <FeaturesProvider>
        <AnalyticsProvider>
          {children}
        </AnalyticsProvider>
      </FeaturesProvider>
    </ThemeProvider>
  )
}

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ReconnectProvider>
      <ProvidersContent>
        {children}
      </ProvidersContent>
    </ReconnectProvider>
  )
}

