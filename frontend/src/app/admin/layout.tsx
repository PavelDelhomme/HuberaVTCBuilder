'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import authService from '@/services/auth.service'
import PageLoader from '@/components/shared/PageLoader'

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const [isChecking, setIsChecking] = useState(true)
  const [isAuthorized, setIsAuthorized] = useState(false)

  useEffect(() => {
    const checkAuth = async () => {
      try {
        // Attendre un peu pour que le token soit bien chargé (surtout après login)
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Vérifier si on vient de se connecter (dans les 5 secondes)
        const loginTimestamp = localStorage.getItem('login_timestamp');
        const justLoggedIn = loginTimestamp && (Date.now() - parseInt(loginTimestamp, 10)) < 5000;
        
        // Si on vient de se connecter, attendre un peu plus
        if (justLoggedIn) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        authService.repairTokenStorage()

        // Vérifier d'abord si le token existe (sinon pont cookie suite Hubera)
        let token = authService.getToken()
        if (!token) {
          const bridged = await authService.trySuiteBridge()
          if (bridged) {
            token = authService.getToken()
          }
        }
        if (!token) {
          authService.saveRedirectUrl()
          router.push('/login')
          return
        }
        
        // Vérifier si l'utilisateur est authentifié
        // Utiliser isAuthenticated() qui vérifie aussi la validité du token
        if (!authService.isAuthenticated()) {
          // Si on vient de se connecter, ne pas rediriger immédiatement - réessayer
          if (justLoggedIn) {
            await new Promise(resolve => setTimeout(resolve, 500));
            // Réessayer une fois
            if (!authService.isAuthenticated()) {
              authService.saveRedirectUrl()
              router.push('/login')
              return
            }
          } else {
            // Pas authentifié, rediriger vers login
            authService.saveRedirectUrl()
            router.push('/login')
            return
          }
        }
        
        const currentUser = authService.getStoredUser()
        if (!currentUser) {
          // Si on vient de se connecter, attendre un peu plus
          if (justLoggedIn) {
            await new Promise(resolve => setTimeout(resolve, 200));
            const retryUser = authService.getStoredUser()
            if (!retryUser) {
              authService.saveRedirectUrl()
              router.push('/login')
              return
            }
          } else {
            // Pas d'utilisateur, rediriger vers login
            authService.saveRedirectUrl()
            router.push('/login')
            return
          }
        }
        
        // Vérifier si super admin (sauf pour certaines pages qui peuvent être accessibles par les tenants)
        // Les pages /admin/dashboard peuvent être accessibles par les tenants sur leur sous-domaine
        const isTenantAdminPage = pathname?.includes('/admin/dashboard') && !pathname?.startsWith('/admin/')
        
        // Pour les pages admin strictes (stats, settings, tenants, etc.), vérifier super admin
        const isStrictAdminPage = pathname?.startsWith('/admin/stats') || 
                                 pathname?.startsWith('/admin/settings') ||
                                 pathname?.startsWith('/admin/tenants') ||
                                 pathname?.startsWith('/admin/users') ||
                                 pathname?.startsWith('/admin/billing') ||
                                 pathname?.startsWith('/admin/security') ||
                                 pathname?.startsWith('/admin/blocks')
        
        if (isStrictAdminPage && !authService.isSuperAdmin()) {
          // Pas super admin, rediriger vers dashboard tenant
          router.push('/dashboard')
          return
        }
        
        // Autoriser l'accès
        setIsAuthorized(true)
      } catch (error) {
        console.error('Error vérification auth:', error)
        authService.saveRedirectUrl()
        router.push('/login')
      } finally {
        setIsChecking(false)
      }
    }
    
    checkAuth()
  }, [router, pathname]) // Re-vérifier lors de la navigation

  if (isChecking) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
        <PageLoader text="Vérification de l'authentification..." />
      </div>
    )
  }

  if (!isAuthorized) {
    return null // La redirection est en cours
  }

  return <>{children}</>
}

