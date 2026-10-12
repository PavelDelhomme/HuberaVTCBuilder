import axios, { AxiosError, InternalAxiosRequestConfig, CancelTokenSource, AxiosHeaders } from 'axios';
import authService from '@/services/auth.service';
import { repairPressTokenStorage } from '@/lib/huberaSuiteAuth';
import { jwtTokenType } from '@/lib/jwtUtils';

// Déclaration pour les flags globaux
declare global {
  interface Window {
    __redirectingToLogin?: boolean;
    __hasLoggedBlockedError?: boolean;
    __hasLoggedNetworkError?: boolean;
    __showReconnectModal?: () => void;
    __isRefreshingToken?: boolean;
    __failedQueue?: Array<{
      resolve: (value?: any) => void;
      reject: (error?: any) => void;
      config: InternalAxiosRequestConfig;
    }>;
  }
}

/**
 * Détermine dynamiquement l'URL de l'API selon l'environnement
 * - En production : utilise l'URL configurée
 * - En développement : détecte automatiquement selon le hostname
 *   - Sur localhost : http://localhost:9495
 *   - Sur sous-domaine tenant : http://localhost:9495 (même backend)
 */
function getApiUrl(): string {
  if (typeof window !== 'undefined') {
    const hostname = window.location.hostname;
    // Same-origin via nginx /api/ (press + cms). Évite CORS press→cms.
    if (hostname.endsWith('.hubera.cloud') || hostname === 'hubera.cloud') {
      return window.location.origin;
    }
    if (hostname === '192.168.1.134' || hostname.includes('192.168.1.134')) {
      return `http://192.168.1.134:9495`;
    }
    if (hostname.includes('localhost') || hostname.includes('127.0.0.1')) {
      return `http://localhost:9495`;
    }
  }
  if (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) {
    return process.env.NEXT_PUBLIC_API_URL;
  }
  return 'http://localhost:9495';
}

const API_URL = getApiUrl();

export const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
  timeout: 30000, // 30 secondes timeout
});

// Intercepteur pour ajouter le token et gérer FormData
api.interceptors.request.use((config) => {
  repairPressTokenStorage();

  const isSuiteBridge = config.url?.includes('/auth/suite-bridge');
  if (isSuiteBridge && config.headers) {
    delete config.headers.Authorization;
    if (config.headers instanceof AxiosHeaders) {
      config.headers.delete('Authorization');
    }
  }

  // Ne pas envoyer le token pour les endpoints analytics qui acceptent AllowAny
  // Cela évite les erreurs 403 si le token est invalide/expiré
  const isAnalyticsEndpoint = config.url?.includes('/analytics/block-usage/');
  
  // Si le flag _skipAuthInterceptor est défini, ne pas modifier le header Authorization
  // (utilisé après un refresh de token pour éviter d'écraser le header déjà défini)
  if ((config as any)._skipAuthInterceptor) {
    delete (config as any)._skipAuthInterceptor;
    // Le header Authorization est déjà défini, s'assurer qu'il est bien présent
    // Vérifier avec différentes méthodes selon le type de headers
    let authHeader: string | undefined;
    if (config.headers instanceof AxiosHeaders) {
      authHeader = config.headers.get('Authorization') as string | undefined;
    } else if (config.headers && typeof config.headers === 'object') {
      authHeader = (config.headers as any).Authorization || (config.headers as any)['Authorization'];
    }
    
    if (!authHeader) {
      console.error('❌ _skipAuthInterceptor activé mais Authorization header manquant!', {
        headers: config.headers,
        headersType: typeof config.headers,
        isAxiosHeaders: config.headers instanceof AxiosHeaders,
        headersKeys: config.headers instanceof AxiosHeaders 
          ? Array.from(config.headers.keys()) 
          : config.headers ? Object.keys(config.headers) : []
      });
    } else {
      console.log('✅ _skipAuthInterceptor: Authorization header préservé:', authHeader.substring(0, 50) + '...');
    }
    return config;
  }
  
  if (!isAnalyticsEndpoint) {
    // Si le header Authorization est déjà défini (par exemple après un refresh), le conserver
    // Sinon, lire depuis localStorage
    const existingAuth = config.headers?.Authorization;
    if (!existingAuth) {
      const token = localStorage.getItem('token');
      if (token && jwtTokenType(token) !== 'refresh') {
        if (!config.headers) {
          config.headers = {} as any;
        }
        config.headers.Authorization = `Bearer ${token}`;
        
        // Log pour les requêtes PATCH vers system-settings pour diagnostic
        if (config.url?.includes('/system-settings/') && (config.method === 'patch' || config.method === 'PATCH')) {
          console.log('🔐 [REQUEST INTERCEPTOR] PATCH /system-settings/ avec token:', {
            url: config.url,
            method: config.method,
            tokenLength: token.length,
            tokenPreview: token.substring(0, 50) + '...',
            hasHeader: !!config.headers.Authorization,
          });
        }
      } else {
        // Si pas de token et que c'est une requête PATCH vers system-settings, c'est CRITIQUE
        const isSystemSettingsPatch = config.url?.includes('/system-settings/') && 
                                      (config.method === 'patch' || config.method === 'PATCH');
        
        if (isSystemSettingsPatch) {
          console.error('❌ [REQUEST INTERCEPTOR] PATCH /system-settings/ SANS TOKEN!', {
            url: config.url,
            method: config.method,
            hasRefreshToken: !!localStorage.getItem('refresh_token'),
            timestamp: new Date().toISOString(),
          });
        }
        
        // Si pas de token et que ce n'est pas un endpoint public ou géré avec données par défaut, logger un avertissement
        const isPublicEndpoint = config.url?.includes('/analytics/') || 
                                 config.url?.includes('/auth/') ||
                                 config.url?.includes('/templates/');
        const isManagedEndpoint = config.url?.includes('/system-settings/') ||
                                 config.url?.includes('/blocks/types/') ||
                                 config.url?.includes('/blocks/call-to-actions/') ||
                                 config.url?.includes('/projects/') ||
                                 config.url?.includes('/dashboard/') ||
                                 config.url?.includes('/stats/detailed/') ||
                                 config.url?.includes('/billing/stats/') ||
                                 config.url?.includes('/users/impersonation-status/');
        if (!isPublicEndpoint && !isManagedEndpoint) {
          console.warn('⚠️ Aucun token trouvé pour la requête:', config.url);
        }
      }
    } else {
      // Header Authorization déjà défini, s'assurer qu'il est bien formaté
      const authValue = typeof existingAuth === 'string' ? existingAuth : String(existingAuth);
      if (!authValue.startsWith('Bearer ')) {
        if (!config.headers) {
          config.headers = {} as any;
        }
        config.headers.Authorization = authValue.startsWith('Bearer') ? authValue : `Bearer ${authValue}`;
      }
      
      // Log pour les requêtes PATCH vers system-settings avec header existant
      if (config.url?.includes('/system-settings/') && (config.method === 'patch' || config.method === 'PATCH')) {
        console.log('🔐 [REQUEST INTERCEPTOR] PATCH /system-settings/ avec header existant:', {
          url: config.url,
          method: config.method,
          authHeaderPreview: authValue.substring(0, 50) + '...',
        });
      }
    }
  } else {
    // S'assurer qu'aucun token n'est envoyé pour les endpoints analytics
    if (config.headers) {
      delete config.headers.Authorization;
    }
  }
  
  // Pour les requêtes PATCH vers /system-settings/, vérifier si l'utilisateur est super admin
  // MAIS: Ne pas annuler si un token est présent - laisser le backend vérifier
  // (car isSuperAdmin() peut retourner false si le token est expiré, mais le refresh peut réussir)
  if (config.url?.includes('/system-settings/') && (config.method === 'patch' || config.method === 'PATCH')) {
    const token = localStorage.getItem('token');
    const hasAuthHeader = !!(config.headers?.Authorization || (config.headers as any)?.['Authorization']);
    
    // Si pas de token ET pas de header Authorization ET pas super admin, annuler
    // MAIS: Si un header Authorization est déjà défini (après refresh), ne pas annuler
    if (!token && !hasAuthHeader && !authService.isSuperAdmin()) {
      console.warn('⚠️ [REQUEST INTERCEPTOR] PATCH /system-settings/ annulée: pas de token, pas de header, pas super admin');
      // Créer un CancelToken et annuler immédiatement
      const source = axios.CancelToken.source();
      source.cancel('Request cancelled: user is not super admin and no token available');
      config.cancelToken = source.token;
      // Marquer la config pour que l'intercepteur de réponse sache que c'est silencieux
      (config as any).__shouldRejectSilently = true;
      (config as any).__isCancelled = true;
      (config as any).__silent = true;
    } else if (!token && !hasAuthHeader) {
      // Si pas de token mais qu'on a un refresh token, attendre un peu pour permettre le refresh
      const refreshToken = localStorage.getItem('refresh_token');
      if (refreshToken) {
        console.warn('⚠️ [REQUEST INTERCEPTOR] PATCH /system-settings/ sans token mais refresh token disponible - la requête partira sans token et déclenchera un refresh');
      } else {
        console.error('❌ [REQUEST INTERCEPTOR] PATCH /system-settings/ sans token ET sans refresh token!');
      }
    }
  }
  
  // Si on envoie un FormData, supprimer le Content-Type pour que le navigateur
  // définisse automatiquement le bon Content-Type avec le boundary
  if (config.data instanceof FormData) {
    delete config.headers['Content-Type'];
  }
  
  return config;
});

// Liste des endpoints où les erreurs 404/401/500 sont attendues (ne pas les logger)
// Note: Les endpoints de création/modification (POST, PATCH, DELETE) ne doivent PAS être silencieux
// car ils indiquent un problème d'authentification qui doit être traité
const SILENT_ERROR_ENDPOINTS = [
  '/payment-methods/',
  '/system-settings/',
  '/billing/unpaid-items/',
  '/billing/stats/', // Endpoint de stats billing - erreurs 401 normales si non connecté
  '/templates/',
  '/pricing-plans/', // Peut être en erreur temporaire
  '/users/impersonation-status/', // Endpoint optionnel (401 normal si non connecté)
  '/dashboard/', // Peut être en erreur temporaire (401 normal si non connecté)
  '/stats/detailed/', // Endpoint de stats détaillées - erreurs 401 normales si non connecté
  '/blocks/types/', // Peut être en erreur temporaire (401 normal si non connecté)
  '/blocks/call-to-actions/', // Endpoint de call-to-actions - erreurs 401 normales si non connecté
  '/projects/', // Endpoint de projects - erreurs 401 normales si non connecté
  '/tenants/features/', // Endpoint de features - erreurs 401 normales si non connecté
  '/analytics/actions/', // Endpoint d'analytics - erreurs 401/403 normales si non connecté
  '/analytics/block-usage/', // Endpoint de tracking - erreurs 401/403 normales si non connecté
  '/analytics/usage-stats/', // Endpoint de stats d'utilisation - erreurs 401/403/500 normales
];

// Intercepteur pour gérer les erreurs
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || '';
    const status = error.response?.status;
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    const hasToken = localStorage.getItem('token');
    const refreshToken = localStorage.getItem('refresh_token');
    
    // PRIORITÉ 0: Gérer IMMÉDIATEMENT les erreurs 401 pour les endpoints gérés AVANT tout autre traitement
    // Pour éviter qu'elles soient loggées dans la console
    const managedEndpoints401 = [
      '/system-settings/',
      '/blocks/types/',
      '/blocks/call-to-actions/',
      '/projects/',
      '/dashboard/',
      '/stats/detailed/',
      '/billing/stats/',
      '/users/impersonation-status/',
    ];
    const isManagedEndpoint401 = status === 401 && managedEndpoints401.some(endpoint => url.includes(endpoint));
    
    // Si c'est une erreur 401 sur un endpoint géré et qu'il n'y a pas de token, retourner des données par défaut silencieusement
    if (isManagedEndpoint401 && !hasToken && originalRequest.method?.toLowerCase() === 'get') {
      // Marquer l'erreur comme silencieuse
      error.silent = true;
      error.config = error.config || {};
      error.config.silent = true;
      
      // Retourner des données par défaut selon l'endpoint
      if (url.includes('/system-settings/')) {
        return Promise.resolve({ 
          data: { public_pages: {}, public_homepage_blocks: [] }, 
          status: 200, 
          statusText: 'OK', 
          headers: {}, 
          config: originalRequest 
        });
      }
      if (url.includes('/blocks/types/') || url.includes('/blocks/call-to-actions/') || url.includes('/projects/')) {
        return Promise.resolve({ 
          data: [], 
          status: 200, 
          statusText: 'OK', 
          headers: {}, 
          config: originalRequest 
        });
      }
      if (url.includes('/dashboard/')) {
        return Promise.resolve({ 
          data: { stats: { total_tenants: 0, active_tenants: 0, trial_tenants: 0, total_users: 0, monthly_revenue: 0, trials_expiring_soon: 0, trials_expiring_soon_list: [] } }, 
          status: 200, 
          statusText: 'OK', 
          headers: {}, 
          config: originalRequest 
        });
      }
      if (url.includes('/stats/detailed/')) {
        return Promise.resolve({ 
          data: { overview: { total_tenants: 0, active_tenants: 0, trial_tenants: 0, total_users: 0, active_subscriptions: 0, trial_subscriptions: 0 }, activity: { users_today: 0, users_this_week: 0, tenants_today: 0, tenants_this_week: 0 }, revenue: { monthly: 0, total: 0 }, alerts: [] }, 
          status: 200, 
          statusText: 'OK', 
          headers: {}, 
          config: originalRequest 
        });
      }
      if (url.includes('/billing/stats/')) {
        return Promise.resolve({ 
          data: { total_revenue: 0, monthly_revenue: 0, active_subscriptions: 0, total_subscriptions: 0 }, 
          status: 200, 
          statusText: 'OK', 
          headers: {}, 
          config: originalRequest 
        });
      }
      if (url.includes('/users/impersonation-status/')) {
        return Promise.resolve({ 
          data: { is_impersonating: false, impersonator_email: null }, 
          status: 200, 
          statusText: 'OK', 
          headers: {}, 
          config: originalRequest 
        });
      }
    }
    
    // Si c'est une erreur 401 sur un endpoint qui nécessite authentification et qu'il n'y a pas de token,
    // rediriger vers login (sauf pour les endpoints gérés qui retournent des données par défaut)
    if (status === 401 && !isManagedEndpoint401 && !hasToken) {
      // Si on est sur une page admin et qu'il n'y a pas de token, rediriger vers login
      if (typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')) {
        // Ne pas rediriger si on est déjà sur la page de login
        if (!window.location.pathname.includes('/login')) {
          authService.saveRedirectUrl()
          window.location.href = '/login'
          // Retourner une promesse rejetée silencieusement pour éviter les logs
          return Promise.reject(new Error('Authentication required'))
        }
      }
    }
    
    // PRIORITÉ 1: Gérer IMMÉDIATEMENT les erreurs 403 pour les endpoints publics
    // AVANT tout autre traitement pour éviter qu'elles soient loggées
    // MAIS: Si l'utilisateur est super admin, ne pas ignorer l'erreur - c'est un vrai problème
    const publicEndpoints403 = [
      '/system-settings/',
      '/analytics/block-usage/',
      '/users/impersonation-status/',
      '/blocks/types/',
      '/blocks/call-to-actions/',
      '/projects/',
      '/dashboard/',
      '/stats/detailed/',
      '/billing/stats/',
      '/security/waf/logs/', // Logs WAF - nécessite permissions super admin
      '/auth/refresh/', // Ajouté pour s'assurer que le refresh token lui-même n'est pas bloqué
      '/auth/login/', // Login - erreurs 403 peuvent survenir si tentatives multiples ou restrictions
    ];
    const isPublicEndpoint403 = status === 403 && publicEndpoints403.some(endpoint => url.includes(endpoint));
    const isSuperAdmin = authService.isSuperAdmin();
    
    // Exception spéciale pour /auth/login/ : ne pas ignorer silencieusement les erreurs 403
    // car elles indiquent un vrai problème (tentatives multiples, restrictions, etc.)
    const isLoginEndpoint = url.includes('/auth/login/');
    
    // Si c'est un utilisateur non-super-admin avec une erreur 403 sur un endpoint public (sauf /auth/login/), ignorer silencieusement
    if (isPublicEndpoint403 && !isSuperAdmin && !isLoginEndpoint) {
      // Marquer l'erreur comme silencieuse pour éviter tout log
      error.silent = true;
      error.config = error.config || {};
      error.config.silent = true;
      // Supprimer complètement les propriétés qui pourraient être loggées
      try {
        if (error.message) {
          Object.defineProperty(error, 'message', { value: '', writable: false, configurable: true });
        }
        if (error.stack) {
          Object.defineProperty(error, 'stack', { value: '', writable: false, configurable: true });
        }
        if (error.response) {
          Object.defineProperty(error.response, 'data', { value: {}, writable: false, configurable: true });
        }
      } catch (e) {}
      // Retourner une promesse résolue silencieusement - ces erreurs sont attendues
      return Promise.resolve({ 
        data: {}, 
        status: 403, 
        statusText: 'Forbidden', 
        headers: {}, 
        config: error.config 
      });
    }
    
    // Si c'est un super admin avec une erreur 403 sur un endpoint public, essayer de rafraîchir le token d'abord
    // MAIS: Ne pas essayer de rafraîchir si la requête est déjà vers /auth/refresh/ (éviter les boucles infinies)
    // ET: Ne pas essayer de rafraîchir si on a déjà essayé (éviter les boucles infinies)
    // ET: Ne pas essayer de rafraîchir si on est déjà en train de rafraîchir (éviter les boucles infinies)
    // ET: Pour les requêtes GET publiques, ne pas essayer de rafraîchir - elles devraient fonctionner sans token
    const isRefreshEndpoint = url.includes('/auth/refresh/');
    const isPublicGetRequest = 
      (url.includes('/system-settings/') && originalRequest.method?.toLowerCase() === 'get') ||
      (url.includes('/blocks/types/') && originalRequest.method?.toLowerCase() === 'get') ||
      (url.includes('/users/impersonation-status/') && originalRequest.method?.toLowerCase() === 'get');
    
    // Pour les requêtes GET publiques avec un token expiré, retirer le token et réessayer
    if (isPublicGetRequest && status === 403 && hasToken) {
      console.warn('⚠️ Requête GET publique avec token expiré, retrait du token et nouvelle tentative...');
      // Retirer le token de la requête
      if (originalRequest.headers) {
        delete originalRequest.headers.Authorization;
      }
      // Réessayer sans token
      return api(originalRequest);
    }
    
    // Ne pas essayer de rafraîchir le token si :
    // 1. C'est une requête GET publique (elles devraient fonctionner sans token)
    // 2. C'est une requête vers /auth/refresh/ (boucle infinie)
    // 3. On a déjà essayé de rafraîchir (éviter les boucles)
    // 4. On est déjà en train de rafraîchir (éviter les requêtes concurrentes)
    // 5. Il n'y a pas de refresh token disponible
    const shouldTryRefresh = 
      isPublicEndpoint403 && 
      isSuperAdmin && 
      hasToken && 
      refreshToken && 
      !originalRequest._retry && 
      !isRefreshEndpoint && 
      !window.__isRefreshingToken && 
      !isPublicGetRequest;
    
    // Gestion spéciale pour /auth/logout/ : permettre la requête même si le token est expiré
    // Le logout doit fonctionner même avec un token expiré car on veut nettoyer les tokens côté client
    const isLogoutEndpoint = url.includes('/auth/logout/');
    if (isLogoutEndpoint && (status === 401 || status === 403)) {
      // Pour le logout, on ne veut pas essayer de rafraîchir le token
      // On retourne une réponse réussie silencieusement car le logout fonctionne de toute façon
      // (les tokens seront nettoyés côté client dans auth.service.ts)
      return Promise.resolve({ 
        data: { message: 'Logged out successfully' }, 
        status: 200, 
        statusText: 'OK', 
        headers: {}, 
        config: error.config 
      });
    }
    
    // Si c'est une erreur 403 sur /auth/refresh/, ne pas essayer de rafraîchir à nouveau (boucle infinie)
    if (isRefreshEndpoint) {
      // Nettoyer les tokens expirés
      localStorage.removeItem('token');
      localStorage.removeItem('refresh_token');
      console.error('❌ Erreur 403 sur /auth/refresh/ - Le refresh token est probablement expiré ou invalide. Veuillez vous reconnecter.');
      // Retourner une erreur claire pour que l'utilisateur sache qu'il doit se reconnecter
      return Promise.reject(new Error('Token de rafraîchissement expiré. Veuillez vous reconnecter.'));
    }
    
    if (shouldTryRefresh) {
      // Vérifier si le refresh token est disponible avant d'essayer de rafraîchir
      const currentRefreshToken = localStorage.getItem('refresh_token');
      if (!currentRefreshToken) {
        console.warn('⚠️ Super admin reçoit 403 mais aucun refresh token disponible - impossible de rafraîchir');
        // Si c'est une requête PATCH vers /system-settings/, cela pourrait être un problème de permissions
        // plutôt qu'un problème de token expiré
        if (originalRequest.url?.includes('/system-settings/') && originalRequest.method?.toLowerCase() === 'patch') {
          console.warn('⚠️ Requête PATCH vers /system-settings/ échouée avec 403 - vérifier les permissions backend');
        }
        return Promise.reject(error);
      }
      
      console.warn('⚠️ Super admin reçoit 403, tentative de rafraîchissement du token...', {
        url: originalRequest.url,
        method: originalRequest.method,
        hasRefreshToken: !!currentRefreshToken,
        refreshTokenLength: currentRefreshToken.length
      });
      originalRequest._retry = true;
      
      if (window.__isRefreshingToken) {
        return new Promise((resolve, reject) => {
          if (!window.__failedQueue) {
            window.__failedQueue = [];
          }
          window.__failedQueue.push({ resolve, reject, config: originalRequest });
        }).then((token) => {
          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${token}`;
          }
          return api(originalRequest);
        }).catch((err: any) => {
          // Si le rafraîchissement échoue et que c'est une requête GET vers /system-settings/, /blocks/types/, /blocks/call-to-actions/, /projects/, /dashboard/, /stats/detailed/, /billing/stats/, ou /users/impersonation-status/, retourner des données par défaut
          if (originalRequest.url?.includes('/system-settings/') && originalRequest.method?.toLowerCase() === 'get') {
            return Promise.resolve({
              data: { public_pages: {}, public_homepage_blocks: [] }, 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            } as any);
          }
          if (originalRequest.url?.includes('/blocks/types/') && originalRequest.method?.toLowerCase() === 'get') {
            return Promise.resolve({ 
              data: [], 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            } as any);
          }
          if (originalRequest.url?.includes('/blocks/call-to-actions/') && originalRequest.method?.toLowerCase() === 'get') {
            return Promise.resolve({ 
              data: [], 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            } as any);
          }
          if (originalRequest.url?.includes('/projects/') && originalRequest.method?.toLowerCase() === 'get') {
            return Promise.resolve({ 
              data: [], 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            } as any);
          }
          if (originalRequest.url?.includes('/dashboard/') && originalRequest.method?.toLowerCase() === 'get') {
            return Promise.resolve({ 
              data: { stats: { total_tenants: 0, active_tenants: 0, trial_tenants: 0, total_users: 0, monthly_revenue: 0, trials_expiring_soon: 0, trials_expiring_soon_list: [] } }, 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            } as any);
          }
          if (originalRequest.url?.includes('/stats/detailed/') && originalRequest.method?.toLowerCase() === 'get') {
            return Promise.resolve({ 
              data: { overview: { total_tenants: 0, active_tenants: 0, trial_tenants: 0, total_users: 0, active_subscriptions: 0, trial_subscriptions: 0 }, activity: { users_today: 0, users_this_week: 0, tenants_today: 0, tenants_this_week: 0 }, revenue: { monthly: 0, total: 0 }, alerts: [] }, 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            } as any);
          }
          if (originalRequest.url?.includes('/billing/stats/') && originalRequest.method?.toLowerCase() === 'get') {
            return Promise.resolve({ 
              data: { total_revenue: 0, monthly_revenue: 0, active_subscriptions: 0, total_subscriptions: 0 }, 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            } as any);
          }
          if (originalRequest.url?.includes('/users/impersonation-status/') && originalRequest.method?.toLowerCase() === 'get') {
            return Promise.resolve({ 
              data: { is_impersonating: false, impersonator_email: null }, 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            } as any);
          }
          if (originalRequest.url?.includes('/security/waf/logs/') && originalRequest.method?.toLowerCase() === 'get') {
            return Promise.resolve({ 
              data: [], 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            } as any);
          }
          return Promise.reject(err);
        });
      }
      
      window.__isRefreshingToken = true;
      
      return authService.refreshToken().then((success) => {
        window.__isRefreshingToken = false;
        
        if (success) {
          // Récupérer le nouveau token immédiatement après refresh
          const newToken = localStorage.getItem('token');
          
          if (!newToken) {
            console.error('❌ Nouveau token non trouvé après refresh - impossible de continuer');
            return Promise.reject(new Error('Token de rafraîchissement échoué - nouveau token non disponible'));
          }
          
          console.log('✅ Token rafraîchi avec succès, nouveau token disponible:', {
            tokenLength: newToken.length,
            tokenPreview: newToken.substring(0, 50) + '...',
            url: originalRequest.url,
            method: originalRequest.method
          });
          
          // Mettre à jour la queue des requêtes en attente
          if (window.__failedQueue) {
            window.__failedQueue.forEach(({ resolve }) => {
              resolve(newToken);
            });
            window.__failedQueue = [];
          }
          
          // IMPORTANT: S'assurer que le token est bien dans localStorage AVANT de réessayer
          // Vérifier que le token a bien été sauvegardé
          const savedToken = localStorage.getItem('token');
          if (!savedToken || savedToken !== newToken) {
            console.warn('⚠️ Token non sauvegardé correctement dans localStorage après refresh, correction...');
            localStorage.setItem('token', newToken);
          }
          
          // IMPORTANT: Créer une nouvelle config avec le nouveau token
          // Le problème est que AxiosHeaders ne se copie pas bien avec le spread operator
          // Il faut créer une nouvelle config et copier manuellement les headers
          
          // Créer un nouvel objet headers en copiant manuellement
          const newHeaders: Record<string, any> = {};
          
          // Copier tous les headers existants (sauf Authorization qui sera remplacé)
          if (originalRequest.headers) {
            const headersObj = originalRequest.headers as any;
            
            // Si c'est un AxiosHeaders, utiliser toJSON() pour obtenir un objet simple
            if (headersObj && typeof headersObj.toJSON === 'function') {
              const headersJson = headersObj.toJSON();
              Object.keys(headersJson).forEach(key => {
                if (key.toLowerCase() !== 'authorization') {
                  newHeaders[key] = headersJson[key];
                }
              });
            } else if (headersObj && typeof headersObj === 'object') {
              // Sinon, copier directement
              Object.keys(headersObj).forEach(key => {
                if (key.toLowerCase() !== 'authorization') {
                  newHeaders[key] = headersObj[key];
                }
              });
            }
          }
          
          // FORCER le header Authorization avec le nouveau token
          newHeaders.Authorization = `Bearer ${newToken}`;
          
          // Créer la nouvelle config en utilisant api.request() avec une config complète
          // Il faut créer un nouvel objet AxiosHeaders pour s'assurer que le header est bien défini
          const retryConfig: InternalAxiosRequestConfig = {
            ...originalRequest,
            headers: new AxiosHeaders(newHeaders),
            // S'assurer que l'URL est correcte
            url: originalRequest.url,
            method: originalRequest.method,
            // S'assurer que les données sont préservées
            data: originalRequest.data,
            params: originalRequest.params,
          };
          
          // S'assurer que le header Authorization est bien défini dans AxiosHeaders
          retryConfig.headers.set('Authorization', `Bearer ${newToken}`);
          
          // S'assurer que l'intercepteur ne va pas écraser ce header
          (retryConfig as any)._skipAuthInterceptor = true;
          
          // VÉRIFICATION CRITIQUE: S'assurer que le header est bien présent AVANT l'envoi
          const authHeaderBeforeSend = retryConfig.headers.get('Authorization');
          const authHeaderStr = typeof authHeaderBeforeSend === 'string' ? authHeaderBeforeSend : String(authHeaderBeforeSend || '');
          if (!authHeaderStr || !authHeaderStr.startsWith('Bearer ')) {
            console.error('❌ [RETRY] Header Authorization manquant AVANT api.request()!', {
              authHeaderBeforeSend,
              headersType: typeof retryConfig.headers,
              isAxiosHeaders: retryConfig.headers instanceof AxiosHeaders,
            });
            // Forcer une dernière fois
            retryConfig.headers.set('Authorization', `Bearer ${newToken}`);
          }
          
          // Log pour debug
          const authHeaderValue = retryConfig.headers.get('Authorization') || 
                                  (retryConfig.headers as any).Authorization || 
                                  'MISSING';
          
          // Obtenir les clés des headers de manière sécurisée
          let allHeadersKeys: string[] = [];
          try {
            if (retryConfig.headers instanceof AxiosHeaders) {
              // AxiosHeaders peut avoir différentes méthodes selon la version
              if (typeof retryConfig.headers.keys === 'function') {
                allHeadersKeys = Array.from(retryConfig.headers.keys());
              } else if (typeof retryConfig.headers.toJSON === 'function') {
                allHeadersKeys = Object.keys(retryConfig.headers.toJSON());
              } else {
                allHeadersKeys = Object.keys(retryConfig.headers as any);
              }
            } else if (retryConfig.headers && typeof retryConfig.headers === 'object') {
              allHeadersKeys = Object.keys(retryConfig.headers);
            }
          } catch (e) {
            console.warn('⚠️ Erreur lors de la lecture des clés des headers:', e);
          }
          
          console.log('🔧 RetryConfig créée:', {
            url: retryConfig.url,
            method: retryConfig.method,
            hasHeaders: !!retryConfig.headers,
            authHeader: typeof authHeaderValue === 'string' ? authHeaderValue.substring(0, 50) + '...' : 'MISSING',
            skipAuthInterceptor: (retryConfig as any)._skipAuthInterceptor,
            allHeaders: allHeadersKeys
          });
          
          // Réessayer la requête avec le nouveau token en utilisant api.request()
          console.log('🔄 Réessai de la requête avec le nouveau token:', {
            url: originalRequest.url,
            method: originalRequest.method,
            hasAuthHeader: !!authHeaderValue && authHeaderValue !== 'MISSING',
            authHeaderValue: typeof authHeaderValue === 'string' ? authHeaderValue.substring(0, 50) + '...' : 'MISSING',
            tokenInLocalStorage: !!localStorage.getItem('token'),
            tokenMatches: localStorage.getItem('token') === newToken,
            tokenLength: newToken.length,
            retryConfigHeadersType: typeof retryConfig.headers,
            isAxiosHeaders: retryConfig.headers instanceof AxiosHeaders,
          });
          
          // VÉRIFICATION FINALE AVANT ENVOI
          let finalAuthHeader: string | undefined;
          try {
            if (retryConfig.headers instanceof AxiosHeaders) {
              finalAuthHeader = retryConfig.headers.get('Authorization') as string | undefined;
            } else if (retryConfig.headers && typeof retryConfig.headers === 'object') {
              finalAuthHeader = (retryConfig.headers as any).Authorization || (retryConfig.headers as any)['Authorization'];
            }
          } catch (e) {
            console.warn('⚠️ [RETRY] Erreur lors de la lecture du header Authorization:', e);
          }
          
          if (!finalAuthHeader || !finalAuthHeader.startsWith('Bearer ')) {
            console.error('❌ [RETRY] Header Authorization manquant ou invalide avant envoi!', {
              finalAuthHeader: typeof finalAuthHeader === 'string' ? finalAuthHeader?.substring(0, 50) : finalAuthHeader,
              headersType: typeof retryConfig.headers,
              isAxiosHeaders: retryConfig.headers instanceof AxiosHeaders,
            });
            
            // FORCER le header une dernière fois
            if (retryConfig.headers instanceof AxiosHeaders) {
              retryConfig.headers.set('Authorization', `Bearer ${newToken}`);
            } else if (retryConfig.headers && typeof retryConfig.headers === 'object') {
              (retryConfig.headers as any).Authorization = `Bearer ${newToken}`;
            }
            console.log('🔧 [RETRY] Header Authorization forcé une dernière fois');
          }
          
          // Utiliser api.request() avec la config complète
          // IMPORTANT: Utiliser directement la méthode HTTP (patch, post, etc.) pour s'assurer que les headers sont préservés
          // Convertir retryConfig en paramètres pour api.patch/post/etc.
          const method = (retryConfig.method || 'get').toLowerCase();
          const url = retryConfig.url || '';
          
          // Extraire les headers comme un objet simple pour éviter les problèmes avec AxiosHeaders
          const headersObj: Record<string, string> = {};
          if (retryConfig.headers instanceof AxiosHeaders) {
            try {
              const headersJson = retryConfig.headers.toJSON();
              Object.keys(headersJson).forEach(key => {
                const value = retryConfig.headers.get(key);
                if (value && typeof value === 'string') {
                  headersObj[key] = value;
                }
              });
            } catch (e) {
              console.warn('⚠️ Erreur lors de la conversion des headers:', e);
              // Fallback: utiliser directement Authorization
              headersObj['Authorization'] = `Bearer ${newToken}`;
            }
          } else if (retryConfig.headers && typeof retryConfig.headers === 'object') {
            Object.keys(retryConfig.headers).forEach(key => {
              const value = (retryConfig.headers as any)[key];
              if (value && typeof value === 'string') {
                headersObj[key] = value;
              }
            });
          }
          
          // S'assurer que Authorization est présent
          if (!headersObj['Authorization'] || !headersObj['Authorization'].startsWith('Bearer ')) {
            headersObj['Authorization'] = `Bearer ${newToken}`;
          }
          
          // Utiliser la méthode HTTP appropriée avec les headers explicites
          const requestConfig = {
            headers: headersObj,
            params: retryConfig.params,
            data: retryConfig.data,
          };
          
          // Marquer pour éviter que l'intercepteur ne modifie les headers
          (requestConfig as any)._skipAuthInterceptor = true;
          
          // Retourner la promesse directement (sans await) car la fonction parente n'est pas async
          let requestPromise;
          if (method === 'patch') {
            requestPromise = api.patch(url, retryConfig.data, requestConfig);
          } else if (method === 'post') {
            requestPromise = api.post(url, retryConfig.data, requestConfig);
          } else if (method === 'put') {
            requestPromise = api.put(url, retryConfig.data, requestConfig);
          } else if (method === 'delete') {
            requestPromise = api.delete(url, requestConfig);
          } else {
            requestPromise = api.get(url, requestConfig);
          }
          
          // Ajouter un log après la résolution de la promesse
          return requestPromise.then(response => {
            console.log('✅ [RETRY] Requête réussie après refresh:', {
              url,
              method,
              status: response.status,
            });
            return response;
          }).catch((retryError: any) => {
            // Vérifier si c'est encore un 403 - cela signifie que le header n'a pas été envoyé
            if (retryError?.response?.status === 403) {
              console.error('❌ [RETRY] 403 après refresh - le header Authorization n\'a probablement pas été envoyé!', {
                url: retryConfig.url,
                method: retryConfig.method,
                authHeaderInConfig: retryConfig.headers instanceof AxiosHeaders 
                  ? retryConfig.headers.get('Authorization')
                  : (retryConfig.headers as any)?.Authorization,
                error: retryError.response?.data,
              });
            }
            throw retryError;
          });
        } else {
          // Si le rafraîchissement échoue et que c'est une requête GET vers /system-settings/ ou /blocks/types/, retourner des données par défaut
          if (originalRequest.url?.includes('/system-settings/') && originalRequest.method?.toLowerCase() === 'get') {
            console.warn('⚠️ Impossible de rafraîchir le token, utilisation de données par défaut pour /system-settings/');
            return Promise.resolve({ 
              data: { public_pages: {}, public_homepage_blocks: [] }, 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            });
          }
          if (originalRequest.url?.includes('/blocks/types/') && originalRequest.method?.toLowerCase() === 'get') {
            console.warn('⚠️ Impossible de rafraîchir le token, utilisation de données par défaut pour /blocks/types/');
            return Promise.resolve({ 
              data: [], 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            });
          }
          // Pour /users/impersonation-status/, retourner une réponse par défaut
          if (originalRequest.url?.includes('/users/impersonation-status/') && originalRequest.method?.toLowerCase() === 'get') {
            console.warn('⚠️ Impossible de rafraîchir le token, utilisation de données par défaut pour /users/impersonation-status/');
            return Promise.resolve({ 
              data: { is_impersonating: false, impersonator_email: null }, 
              status: 200, 
              statusText: 'OK', 
              headers: {}, 
              config: originalRequest 
            });
          }
          // Ne logger l'erreur que si ce n'est pas une requête GET silencieuse
          // Pour les requêtes PATCH, on doit logger l'erreur pour diagnostiquer
          const isSilentGetRequest = 
            (originalRequest.url?.includes('/system-settings/') && originalRequest.method?.toLowerCase() === 'get') ||
            (originalRequest.url?.includes('/blocks/types/') && originalRequest.method?.toLowerCase() === 'get') ||
            (originalRequest.url?.includes('/users/impersonation-status/') && originalRequest.method?.toLowerCase() === 'get');
          
          if (!isSilentGetRequest) {
            // Améliorer le logging pour diagnostiquer le problème
            const refreshTokenAvailable = !!localStorage.getItem('refresh_token');
            const refreshTokenLength = localStorage.getItem('refresh_token')?.length || 0;
            console.error('❌ Impossible de rafraîchir le token pour super admin (refreshToken() a retourné false)', {
              url: originalRequest.url,
              method: originalRequest.method,
              hasRefreshToken: refreshTokenAvailable,
              refreshTokenLength: refreshTokenLength,
              originalErrorStatus: status,
              originalErrorUrl: url,
              note: 'Le refreshToken() a probablement échoué - vérifier les logs précédents pour plus de détails'
            });
          }
          return Promise.reject(error);
        }
      }).catch((refreshError: any): any => {
        window.__isRefreshingToken = false;
        
        // Si le refresh token est expiré, nettoyer les tokens
        if (refreshError?.response?.status === 403 || refreshError?.response?.status === 401) {
          localStorage.removeItem('token');
          localStorage.removeItem('refresh_token');
        }
        
        // Traiter la queue des requêtes en attente avec erreur
        if (window.__failedQueue) {
          window.__failedQueue.forEach(({ reject }) => {
            reject(refreshError);
          });
          window.__failedQueue = [];
        }
        
        // Vérifier si c'est une requête GET silencieuse qui ne nécessite pas de redirection
        const isSilentGetRequest = 
          (originalRequest.url?.includes('/system-settings/') && originalRequest.method?.toLowerCase() === 'get') ||
          (originalRequest.url?.includes('/blocks/types/') && originalRequest.method?.toLowerCase() === 'get') ||
          (originalRequest.url?.includes('/blocks/call-to-actions/') && originalRequest.method?.toLowerCase() === 'get') ||
          (originalRequest.url?.includes('/projects/') && originalRequest.method?.toLowerCase() === 'get') ||
          (originalRequest.url?.includes('/dashboard/') && originalRequest.method?.toLowerCase() === 'get') ||
          (originalRequest.url?.includes('/stats/detailed/') && originalRequest.method?.toLowerCase() === 'get') ||
          (originalRequest.url?.includes('/billing/stats/') && originalRequest.method?.toLowerCase() === 'get') ||
          (originalRequest.url?.includes('/users/impersonation-status/') && originalRequest.method?.toLowerCase() === 'get');
        
        // Ne pas rediriger vers login pour les requêtes GET silencieuses ou si le refresh token a échoué
        // Seulement rediriger pour les requêtes importantes (PATCH, POST, DELETE) qui nécessitent vraiment l'authentification
        const isImportantRequest = originalRequest.method?.toLowerCase() === 'patch' || 
                                   originalRequest.method?.toLowerCase() === 'post' || 
                                   originalRequest.method?.toLowerCase() === 'delete';
        
        // Ne PAS rediriger automatiquement si le refresh a réussi mais que le retry a échoué
        // (cela peut être une erreur temporaire, pas forcément une expiration de token)
        // Vérifier si le refresh a réellement échoué (refreshError existe) ou si c'est juste une erreur de retry
        const refreshFailed = refreshError && (refreshError.response?.status === 401 || refreshError.response?.status === 403);
        const isRetryError = refreshError?.message?.includes('retryConfig') || refreshError?.message?.includes('keys is not a function');
        
        // Ne rediriger que si le refresh a vraiment échoué (token expiré) et pas si c'est juste une erreur technique
        if (refreshFailed && !isRetryError && !isSilentGetRequest && isImportantRequest && typeof window !== 'undefined' && window.location.pathname.startsWith('/admin')) {
          // Ne rediriger que si on n'est pas déjà sur la page de login
          if (!window.location.pathname.includes('/login')) {
            // Attendre un peu avant de rediriger pour éviter les redirections multiples
            const shouldRedirect = !window.__redirectingToLogin;
            if (shouldRedirect) {
              window.__redirectingToLogin = true;
              authService.saveRedirectUrl();
              setTimeout(() => {
                window.__redirectingToLogin = false;
                window.location.href = '/login';
              }, 500);
            }
          }
        }
        
        if (!isSilentGetRequest) {
          console.error('❌ Erreur lors du rafraîchissement du token pour super admin', {
            url: originalRequest.url,
            method: originalRequest.method,
            refreshErrorStatus: refreshError?.response?.status,
            refreshErrorDetails: refreshError?.response?.data || refreshError?.message,
            originalErrorStatus: status,
            originalErrorUrl: url
          });
        }
        
        // Si c'est une requête GET vers /system-settings/, /blocks/types/, /blocks/call-to-actions/, /projects/, /dashboard/, /stats/detailed/, /billing/stats/, ou /users/impersonation-status/, retourner des données par défaut plutôt que de rejeter
        if (originalRequest.url?.includes('/system-settings/') && originalRequest.method?.toLowerCase() === 'get') {
          console.warn('⚠️ Échec du rafraîchissement du token, utilisation de données par défaut pour /system-settings/');
          return Promise.resolve({ 
            data: { public_pages: {}, public_homepage_blocks: [] }, 
            status: 200, 
            statusText: 'OK', 
            headers: {}, 
            config: originalRequest 
          });
        }
        if (originalRequest.url?.includes('/blocks/types/') && originalRequest.method?.toLowerCase() === 'get') {
          console.warn('⚠️ Échec du rafraîchissement du token, utilisation de données par défaut pour /blocks/types/');
          return Promise.resolve({ 
            data: [], 
            status: 200, 
            statusText: 'OK', 
            headers: {}, 
            config: originalRequest 
          });
        }
        if (originalRequest.url?.includes('/blocks/call-to-actions/') && originalRequest.method?.toLowerCase() === 'get') {
          console.warn('⚠️ Échec du rafraîchissement du token, utilisation de données par défaut pour /blocks/call-to-actions/');
          return Promise.resolve({ 
            data: [], 
            status: 200, 
            statusText: 'OK', 
            headers: {}, 
            config: originalRequest 
          });
        }
        if (originalRequest.url?.includes('/projects/') && originalRequest.method?.toLowerCase() === 'get') {
          console.warn('⚠️ Échec du rafraîchissement du token, utilisation de données par défaut pour /projects/');
          return Promise.resolve({ 
            data: [], 
            status: 200, 
            statusText: 'OK', 
            headers: {}, 
            config: originalRequest 
          });
        }
        if (originalRequest.url?.includes('/dashboard/') && originalRequest.method?.toLowerCase() === 'get') {
          console.warn('⚠️ Échec du rafraîchissement du token, utilisation de données par défaut pour /dashboard/');
          return Promise.resolve({ 
            data: { stats: { total_tenants: 0, active_tenants: 0, trial_tenants: 0, total_users: 0, monthly_revenue: 0, trials_expiring_soon: 0, trials_expiring_soon_list: [] } }, 
            status: 200, 
            statusText: 'OK', 
            headers: {}, 
            config: originalRequest 
          });
        }
        if (originalRequest.url?.includes('/stats/detailed/') && originalRequest.method?.toLowerCase() === 'get') {
          console.warn('⚠️ Échec du rafraîchissement du token, utilisation de données par défaut pour /stats/detailed/');
          return Promise.resolve({ 
            data: { overview: { total_tenants: 0, active_tenants: 0, trial_tenants: 0, total_users: 0, active_subscriptions: 0, trial_subscriptions: 0 }, activity: { users_today: 0, users_this_week: 0, tenants_today: 0, tenants_this_week: 0 }, revenue: { monthly: 0, total: 0 }, alerts: [] }, 
            status: 200, 
            statusText: 'OK', 
            headers: {}, 
            config: originalRequest 
          });
        }
        if (originalRequest.url?.includes('/billing/stats/') && originalRequest.method?.toLowerCase() === 'get') {
          console.warn('⚠️ Échec du rafraîchissement du token, utilisation de données par défaut pour /billing/stats/');
          return Promise.resolve({ 
            data: { total_revenue: 0, monthly_revenue: 0, active_subscriptions: 0, total_subscriptions: 0 }, 
            status: 200, 
            statusText: 'OK', 
            headers: {}, 
            config: originalRequest 
          });
        }
        
        // Pour les requêtes PATCH vers /system-settings/, logger un message clair indiquant que le refresh token est expiré
        if (originalRequest.url?.includes('/system-settings/') && originalRequest.method?.toLowerCase() === 'patch') {
          console.error('❌ Échec du rafraîchissement du token pour PATCH /system-settings/. Le refresh token est probablement expiré. Veuillez vous reconnecter.');
          // Rejeter avec un message clair pour que l'utilisateur sache qu'il doit se reconnecter
          return Promise.reject(new Error('Token de rafraîchissement expiré. Veuillez vous reconnecter pour continuer.'));
        }
        if (originalRequest.url?.includes('/users/impersonation-status/') && originalRequest.method?.toLowerCase() === 'get') {
          console.warn('⚠️ Échec du rafraîchissement du token, utilisation de données par défaut pour /users/impersonation-status/');
          return Promise.resolve({ 
            data: { is_impersonating: false, impersonator_email: null }, 
            status: 200, 
            statusText: 'OK', 
            headers: {}, 
            config: originalRequest 
          });
        }
        // Pour les requêtes PATCH vers /system-settings/, logger l'erreur pour diagnostic mais ne pas créer de boucle
        if (originalRequest.url?.includes('/system-settings/') && originalRequest.method?.toLowerCase() === 'patch') {
          console.error('❌ Échec du rafraîchissement du token pour PATCH /system-settings/. Le refresh token est probablement expiré. Veuillez vous reconnecter.', {
            url: originalRequest.url,
            method: originalRequest.method,
            hasRefreshToken: !!localStorage.getItem('refresh_token'),
            refreshErrorStatus: refreshError?.response?.status,
            refreshErrorData: refreshError?.response?.data,
          });
          // Retourner une erreur claire pour que l'utilisateur sache qu'il doit se reconnecter
          return Promise.reject(new Error('Token expiré. Veuillez vous reconnecter pour sauvegarder vos modifications.'));
        }
        // Ne pas logger d'erreur si c'est juste que le refresh token n'existe pas
        const refreshToken = localStorage.getItem('refresh_token');
        if (refreshToken) {
          // Seulement logger si on avait un refresh token mais que ça a échoué
          // et seulement en mode développement
          if (process.env.NODE_ENV === 'development') {
            console.warn('⚠️ Échec du rafraîchissement du token (peut être normal si le token est expiré):', refreshError);
          }
        }
        // Rejeter avec l'erreur originale
        return Promise.reject(error);
      });
    }
    
    // Pour les erreurs silencieuses (requêtes bloquées avant envoi), retourner une promesse résolue silencieusement
    // Gérer les requêtes annulées pour /system-settings/ si l'utilisateur n'est pas super admin
    if (axios.isCancel(error)) {
      // Si c'est une requête annulée pour /system-settings/ et que l'utilisateur n'est pas super admin, ignorer silencieusement
      const requestUrl = originalRequest?.url || (error as any).config?.url || '';
      if (requestUrl.includes('/system-settings/') && !authService.isSuperAdmin()) {
        // Supprimer le message d'error pour éviter qu'il soit loggé
        try {
          if (error.message) {
            Object.defineProperty(error, 'message', { value: '', writable: false, configurable: true });
          }
        } catch (e) {}
        (error as any).silent = true;
        return Promise.resolve({ 
          data: {}, 
          status: 403, 
          statusText: 'Forbidden', 
          headers: {}, 
          config: originalRequest || (error as any).config
        });
      }
      // Pour les autres requêtes annulées, rejeter normalement
      return Promise.reject(error);
    }
    
    // Gérer les erreurs personnalisées avec flag __shouldRejectSilently (requêtes bloquées dans l'intercepteur de requête)
    // Ces erreurs sont créées quand une requête est bloquée AVANT d'être envoyée
    if ((error as any).__shouldRejectSilently || (error as any).__isCancelled || (originalRequest as any).__shouldRejectSilently || (originalRequest as any).__isCancelled) {
      // Supprimer le message d'error pour éviter qu'il soit loggé
      try {
        if (error.message) {
          Object.defineProperty(error, 'message', { value: '', writable: false, configurable: true });
        }
      } catch (e) {}
      (error as any).silent = true;
      return Promise.resolve({ 
        data: {}, 
        status: 403, 
        statusText: 'Forbidden', 
        headers: {}, 
        config: originalRequest || (error as any).config
      });
    }
    
    if ((error as any).silent === true || (originalRequest as any).__shouldRejectSilently) {
      return Promise.resolve({ 
        data: {}, 
        status: 403, 
        statusText: 'Forbidden', 
        headers: {}, 
        config: originalRequest 
      });
    }
    
    // Pour les erreurs 403 sur /system-settings/, vérifier immédiatement si l'utilisateur n'est pas super admin
    // Si c'est le cas, retourner une promesse résolue silencieusement AVANT tout autre traitement
    if (status === 403 && url.includes('/system-settings/')) {
      if (!authService.isSuperAdmin()) {
        // Marquer l'error comme silencieuse pour éviter qu'elle soit loggée
        error.silent = true;
        error.config = error.config || {};
        error.config.silent = true;
        // Supprimer l'error de la console en interceptant avant qu'elle soit loggée
        // Empêcher le navigateur de logger cette erreur en masquant l'objet error
        try {
          Object.defineProperty(error, 'message', { value: '', writable: false, configurable: true });
          Object.defineProperty(error, 'stack', { value: '', writable: false, configurable: true });
          // Masquer aussi la requête pour éviter les logs dans la console réseau
          if (error.request) {
            Object.defineProperty(error.request, 'status', { value: 0, writable: false, configurable: true });
          }
        } catch (e) {}
        // Retourner une promesse résolue silencieusement sans logger
        return Promise.resolve({ 
          data: {}, 
          status: 403, 
          statusText: 'Forbidden', 
          headers: {}, 
          config: originalRequest 
        });
      }
    }
    
    // Marquer les erreurs 401/403 pour les endpoints silencieux comme silencieuses
    const isSilentError = SILENT_ERROR_ENDPOINTS.some(endpoint => url.includes(endpoint));
    
    // Pour les erreurs 403 sur system-settings avec un token, essayer de rafraîchir le token
    // car cela peut indiquer que le token a expiré
    if (status === 403 && url.includes('/system-settings/') && hasToken && refreshToken && !originalRequest._retry) {
      originalRequest._retry = true;
      
      // Si on est déjà en train de rafraîchir, mettre en queue
      if (window.__isRefreshingToken) {
        return new Promise((resolve, reject) => {
          if (!window.__failedQueue) {
            window.__failedQueue = [];
          }
          window.__failedQueue.push({ resolve, reject, config: originalRequest });
        }).then((token) => {
          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${token}`;
          }
          return api(originalRequest);
        }).catch((err) => {
          return Promise.reject(err);
        });
      }
      
      window.__isRefreshingToken = true;
      
      return authService.refreshToken().then((success) => {
        window.__isRefreshingToken = false;
        
        if (success) {
          // Traiter la queue des requêtes en attente
          if (window.__failedQueue) {
            window.__failedQueue.forEach(({ resolve }) => {
              const newToken = localStorage.getItem('token');
              resolve(newToken);
            });
            window.__failedQueue = [];
          }
          
          // Réessayer la requête originale avec le nouveau token
          const newToken = localStorage.getItem('token');
          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
          }
          // Vérifier si c'est une requête vers /system-settings/ et si l'utilisateur n'est pas super admin
          // Si c'est le cas, ne pas réessayer et retourner silencieusement
          if (originalRequest.url?.includes('/system-settings/') && !authService.isSuperAdmin()) {
            return Promise.resolve({ 
              data: {}, 
              status: 403, 
              statusText: 'Forbidden', 
              headers: {}, 
              config: originalRequest 
            });
          }
          return api(originalRequest);
        } else {
          // Refresh token invalide, retourner une promesse résolue silencieusement
          // Vérifier si l'utilisateur n'est pas super admin pour /system-settings/
          if (url.includes('/system-settings/') && !authService.isSuperAdmin()) {
            // Ne pas logger, retourner silencieusement
            return Promise.resolve({ 
              data: {}, 
              status: 403, 
              statusText: 'Forbidden', 
              headers: {}, 
              config: error.config 
            });
          }
          error.silent = true;
          return Promise.resolve({ 
            data: {}, 
            status: 403, 
            statusText: 'Forbidden', 
            headers: {}, 
            config: error.config 
          });
        }
      }).catch((refreshError) => {
        window.__isRefreshingToken = false;
        
        // Traiter la queue des requêtes en attente avec erreur
        if (window.__failedQueue) {
          window.__failedQueue.forEach(({ reject }) => {
            reject(refreshError);
          });
          window.__failedQueue = [];
        }
        
        // Pour les endpoints silencieux, retourner une promesse résolue au lieu de rejeter
        if (isSilentError) {
          error.silent = true;
          return Promise.resolve({ 
            data: {}, 
            status: 403, 
            statusText: 'Forbidden', 
            headers: {}, 
            config: error.config 
          });
        }
        
        error.silent = true;
        return Promise.reject(error);
      });
    }
    
    // Vérifier si l'error est marquée comme silencieuse (depuis l'intercepteur de requête)
    // ou si c'est une erreur de cancellation pour /system-settings/
    // ou si c'est une erreur 403 pour /system-settings/ ou /analytics/block-usage/
    const isSystemSettings403 = url.includes('/system-settings/') && status === 403;
    const isAnalytics403 = url.includes('/analytics/block-usage/') && status === 403;
    const isCancelledRequest = (axios.isCancel && axios.isCancel(error)) || 
                               (error as any).__CANCEL__ || 
                               (error as any).__isCancelled ||
                               error.message?.includes('cancelled') ||
                               error.message?.includes('Not super admin');
    
    if (error.silent || isCancelledRequest || isSystemSettings403 || isAnalytics403) {
      // Retourner une promesse résolue sans logger - c'est attendu pour ces endpoints
      return Promise.resolve({ 
        data: {}, 
        status: error.response?.status || 403, 
        statusText: error.response?.statusText || 'Forbidden', 
        headers: {}, 
        config: error.config || (error as any).config 
      });
    }
    
    if ((status === 401 || status === 403) && isSilentError) {
      // Supprimer l'error de la console en interceptant avant qu'elle soit loggée
      error.silent = true;
      // Ne pas afficher l'error dans la console
      error.config = error.config || {};
      error.config.silent = true;
      // Pour toutes les erreurs 401/403 sur les endpoints silencieux, retourner une promesse résolue silencieusement
      // Cela évite que l'error soit loggée dans la console
      return Promise.resolve({ 
        data: {}, 
        status: status, 
        statusText: status === 401 ? 'Unauthorized' : 'Forbidden', 
        headers: {}, 
        config: error.config 
      });
    }
    
    // Gérer spécifiquement les erreurs 403 pour /system-settings/ et /analytics/block-usage/
    // Même si elles ne sont pas dans SILENT_ERROR_ENDPOINTS, elles doivent être silencieuses
    if (status === 403 && (url.includes('/system-settings/') || url.includes('/analytics/block-usage/'))) {
      // Marquer l'erreur comme silencieuse pour éviter tout log
      error.silent = true;
      error.config = error.config || {};
      error.config.silent = true;
      // Supprimer complètement les propriétés qui pourraient être loggées
      try {
        if (error.message) {
          Object.defineProperty(error, 'message', { value: '', writable: false, configurable: true });
        }
        if (error.stack) {
          Object.defineProperty(error, 'stack', { value: '', writable: false, configurable: true });
        }
        if (error.response) {
          Object.defineProperty(error.response, 'data', { value: {}, writable: false, configurable: true });
        }
      } catch (e) {}
      // Retourner une promesse résolue silencieusement - ces erreurs sont attendues
      return Promise.resolve({ 
        data: {}, 
        status: 403, 
        statusText: 'Forbidden', 
        headers: {}, 
        config: error.config 
      });
    }
    
    // ERR_BLOCKED_BY_CLIENT est généralement causé par un bloqueur de publicité
    // Ne pas logger ces erreurs comme des erreurs critiques pour certains endpoints
    const silentEndpoints = [
      '/tenants/features/', 
      '/auth/login/',
      '/users/impersonation-status/',
      '/dashboard/',
      '/analytics/usage-stats/',
      '/analytics/actions/', // Endpoint d'analytics - erreurs 401/403 normales si non connecté
      '/security/waf/logs/', // Logs WAF - erreurs 403 normales si pas de permissions
    ]
    const isSilentEndpoint = silentEndpoints.some(endpoint => url.includes(endpoint))
    
    // PRIORITÉ 0.5: Gérer les erreurs WAF (Request blocked by WAF) AVANT tout autre traitement
    // Ne détecter les erreurs WAF que si c'est vraiment une erreur WAF du backend
    // Vérifier que c'est bien une erreur 403 avec un message WAF explicite
    const isWAFError = (error.response?.status === 403 || error.response?.status === 429) &&
                      (error.response?.data?.error?.includes('WAF') || 
                       error.response?.data?.detail?.includes('WAF') ||
                       error.response?.data?.error?.includes('blocked by WAF') ||
                       error.response?.data?.error?.includes('Request blocked by WAF') ||
                       error.response?.data?.message?.includes('WAF'));
    
    if (isWAFError) {
      // Pour les erreurs WAF, créer une erreur claire avec un message explicite
      const wafMessage = error.response?.data?.error || 
                        error.response?.data?.detail || 
                        error.response?.data?.message ||
                        'Votre requête a été bloquée par le système de sécurité (WAF). Veuillez réessayer dans quelques instants ou contactez le support si le problème persiste.';
      const wafError = new Error(wafMessage);
      (wafError as any).isWAFError = true;
      (wafError as any).status = error.response?.status || 403;
      (wafError as any).response = error.response;
      return Promise.reject(wafError);
    }
    
    // Gérer les erreurs bloquées par le client (bloqueur de pub)
    const isBlockedError = error.code === 'ERR_BLOCKED_BY_CLIENT' || 
                          error.message?.includes('ERR_BLOCKED_BY_CLIENT') ||
                          error.message?.includes('blocked by client');
    
    if (isBlockedError) {
      // Pour les endpoints silencieux, ne rien logger (géré dans FeaturesContext/authService)
      // Pour les autres endpoints critiques, logger une seule fois de manière discrète
      if (!isSilentEndpoint && !window.__hasLoggedBlockedError) {
        // Logger de manière discrète pour les endpoints critiques
        console.warn(`⚠️ Requête bloquée (bloqueur de publicité): ${url}`);
        console.warn('💡 Solution: Désactivez temporairement votre bloqueur de publicité pour localhost:9495');
        window.__hasLoggedBlockedError = true;
      }
      // Pour les endpoints silencieux, ne rien logger du tout
    } else if (error.code === 'ERR_NETWORK' || error.code === 'ECONNREFUSED') {
      // Erreurs réseau normales (backend non démarré, etc.)
      if (!isSilentEndpoint && !window.__hasLoggedNetworkError) {
        console.warn(`⚠️ Error réseau: ${url} (backend non accessible?)`);
        window.__hasLoggedNetworkError = true;
      }
    }
    
    // Liste des routes publiques où on ne doit PAS rediriger vers /login
    const publicRoutes = ['/', '/templates', '/pricing', '/about', '/contact'];
    const isPublicRoute = typeof window !== 'undefined' && publicRoutes.some(route => 
      window.location.pathname === route || window.location.pathname.startsWith(route + '/')
    );
    
    if (status === 401) {
      const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
      const hasToken = localStorage.getItem('token');
      const refreshToken = localStorage.getItem('refresh_token');
      
      // Pour les endpoints silencieux avec 401, ne pas logger (c'est normal si non connecté)
      // Ces erreurs sont attendues et gérées gracieusement dans les composants
      // Utiliser isSilentError défini plus haut (ligne 100)
      if (isSilentError && !hasToken) {
        // Ne rien logger, c'est attendu - rejeter silencieusement
        // Supprimer l'error de la console en interceptant avant qu'elle soit loggée
        error.silent = true;
        return Promise.reject(error);
      }
      
      // Si on a un token et un refresh token, essayer de rafraîchir automatiquement
      // Ne pas rafraîchir pour l'endpoint de refresh lui-même pour éviter les boucles infinies
      if (hasToken && refreshToken && !originalRequest._retry && !url.includes('/auth/refresh/')) {
        // Vérifier si on vient de se connecter (dans les 10 secondes)
        // Si oui, attendre un peu avant de rafraîchir pour éviter les problèmes de timing
        const loginTimestamp = localStorage.getItem('login_timestamp');
        const justLoggedIn = loginTimestamp && (Date.now() - parseInt(loginTimestamp, 10)) < 10000;
        
        // Si on vient de se connecter, attendre un peu avant de rafraîchir
        // Augmenter le délai à 1000ms pour laisser plus de temps au token de se propager
        if (justLoggedIn) {
          // Marquer immédiatement comme retry pour éviter les retries multiples
          originalRequest._retry = true;
          
          return new Promise((resolve) => {
            setTimeout(() => {
              // Si on est déjà en train de rafraîchir, mettre en queue
              if (window.__isRefreshingToken) {
                if (!window.__failedQueue) {
                  window.__failedQueue = [];
                }
                window.__failedQueue.push({ 
                  resolve: (token: any) => {
                    if (originalRequest.headers) {
                      originalRequest.headers.Authorization = `Bearer ${token}`;
                    }
                    resolve(api(originalRequest));
                  }, 
                  reject: (err: any) => resolve(Promise.reject(err)), 
                  config: originalRequest 
                });
                return;
              }
              
              window.__isRefreshingToken = true;
              
              authService.refreshToken().then((success) => {
                window.__isRefreshingToken = false;
                
                if (success) {
                  // Traiter la queue des requêtes en attente
                  if (window.__failedQueue) {
                    window.__failedQueue.forEach(({ resolve: queueResolve }) => {
                      const newToken = localStorage.getItem('token');
                      queueResolve(newToken);
                    });
                    window.__failedQueue = [];
                  }
                  
                  // Réessayer la requête originale avec le nouveau token
                  const newToken = localStorage.getItem('token');
                  if (originalRequest.headers) {
                    originalRequest.headers.Authorization = `Bearer ${newToken}`;
                  }
                  resolve(api(originalRequest));
                } else {
                  // Refresh token invalide, sauvegarder l'état de l'éditeur et afficher le modal
                  if (window.__showReconnectModal) {
                    window.__showReconnectModal();
                  }
                  resolve(Promise.reject(error));
                }
              }).catch((refreshError) => {
                window.__isRefreshingToken = false;
                
                // Traiter la queue des requêtes en attente avec erreur
                if (window.__failedQueue) {
                  window.__failedQueue.forEach(({ reject }) => {
                    reject(refreshError);
                  });
                  window.__failedQueue = [];
                }
                
                // Si le refresh token est expiré, nettoyer les tokens
                if (refreshError?.response?.status === 403 || refreshError?.response?.status === 401) {
                  localStorage.removeItem('token');
                  localStorage.removeItem('refresh_token');
                }
                
                resolve(Promise.reject(error));
              });
            }, 1000); // Augmenté de 500ms à 1000ms pour laisser plus de temps
          });
        }
        
        // Si on ne vient pas de se connecter, rafraîchir normalement
        originalRequest._retry = true;
        
        // Si on est déjà en train de rafraîchir, mettre en queue
        if (window.__isRefreshingToken) {
          return new Promise((resolve, reject) => {
            if (!window.__failedQueue) {
              window.__failedQueue = [];
            }
            window.__failedQueue.push({ resolve, reject, config: originalRequest });
          }).then((token) => {
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            return api(originalRequest);
          }).catch((err) => {
            return Promise.reject(err);
          });
        }
        
        window.__isRefreshingToken = true;
        
        return authService.refreshToken().then((success) => {
          window.__isRefreshingToken = false;
          
          if (success) {
            // Traiter la queue des requêtes en attente
            if (window.__failedQueue) {
              window.__failedQueue.forEach(({ resolve }) => {
                const newToken = localStorage.getItem('token');
                resolve(newToken);
              });
              window.__failedQueue = [];
            }
            
            // Réessayer la requête originale avec le nouveau token
            const newToken = localStorage.getItem('token');
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${newToken}`;
            }
            return api(originalRequest);
          } else {
            // Refresh token invalide, sauvegarder l'état de l'éditeur et afficher le modal
            // L'état sera sauvegardé automatiquement par le contexte avant d'afficher le modal
            if (window.__showReconnectModal) {
              window.__showReconnectModal();
            }
            return Promise.reject(error);
          }
        }).catch((refreshError) => {
          window.__isRefreshingToken = false;
          
          // Traiter la queue des requêtes en attente avec erreur
          if (window.__failedQueue) {
            window.__failedQueue.forEach(({ reject }) => {
              reject(refreshError);
            });
            window.__failedQueue = [];
          }
          
          // Afficher le modal de reconnexion
          if (window.__showReconnectModal) {
            window.__showReconnectModal();
          }
          return Promise.reject(refreshError);
        });
      }
      
      // Si pas de token ou refresh token invalide, gérer selon le contexte
      const isModificationRequest = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(error.config?.method?.toUpperCase() || '');
      
      // Pour les endpoints silencieux, ne pas logger ni rediriger
      if (isSilentError) {
        return Promise.reject(error);
      }
      
      // Pour les requêtes de modification ou pages non publiques avec token, afficher le modal
      // MAIS: Ne pas rediriger si l'utilisateur vient de se connecter (dans les 5 secondes)
      const loginTimestamp = localStorage.getItem('login_timestamp');
      const justLoggedIn = loginTimestamp && (Date.now() - parseInt(loginTimestamp, 10)) < 5000;
      
      if ((isModificationRequest && hasToken) || (hasToken && !isPublicRoute)) {
        // Si l'utilisateur vient de se connecter, ne pas rediriger - c'est probablement un problème temporaire
        if (justLoggedIn) {
          // Marquer immédiatement comme retry pour éviter les retries multiples
          originalRequest._retry = true;
          
          console.warn('⚠️ Erreur 401 juste après la connexion - ne pas rediriger, réessayer la requête après délai');
          // Réessayer la requête après un délai plus long pour éviter les requêtes trop rapides
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              // Réessayer avec le token actuel
              if (originalRequest.headers) {
                const token = localStorage.getItem('token');
                if (token) {
                  originalRequest.headers.Authorization = `Bearer ${token}`;
                }
              }
              api(originalRequest).then(resolve).catch(reject);
            }, 2000); // Augmenté de 1000ms à 2000ms pour éviter les requêtes trop rapides
          });
        }
        
        // Afficher le modal de reconnexion au lieu de rediriger
        if (window.__showReconnectModal) {
          window.__showReconnectModal();
        } else {
          // Fallback : rediriger si le modal n'est pas disponible
          // Sauvegarder l'URL actuelle avant de rediriger
          authService.saveRedirectUrl();
          localStorage.removeItem('token');
          localStorage.removeItem('refresh_token');
          localStorage.removeItem('user');
          window.location.href = '/login';
        }
      }
      
      // Ne pas logger les erreurs 401 - elles sont gérées gracieusement
    } else if (!isSilentError && status) {
      // Ne logger que les erreurs non attendues
      // (Les erreurs attendues sont gérées gracieusement dans les composants)
    }
    
    return Promise.reject(error);
  }
);

export default api;

