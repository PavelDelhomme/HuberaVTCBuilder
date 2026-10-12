import api from '@/lib/api';
import axios from 'axios';
import {
  hasUsablePressAccessToken,
  onHuberaCloudHost,
  repairPressTokenStorage,
} from '@/lib/huberaSuiteAuth';
import { isAccessTokenUsable, jwtTokenType } from '@/lib/jwtUtils';

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  name: string;
  email: string;
  password: string;
  password_confirmation: string;
  phone?: string;
  company_name?: string;
}

export interface User {
  id: number;
  name: string;
  email: string;
  tenant_id?: number;
  roles: any[];
  permissions: any[];
}

class AuthService {
  repairTokenStorage(): void {
    repairPressTokenStorage();
  }

  /**
   * Cookie suite (Cloudity) → JWT Press via /api/auth/suite-bridge/.
   * N'utilise pas les JWT Cloudity comme Bearer Press.
   */
  async trySuiteBridge(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    if (!onHuberaCloudHost()) return false;
    repairPressTokenStorage();
    if (hasUsablePressAccessToken()) return true;

    try {
      const response = await api.post(
        '/auth/suite-bridge/',
        {},
        { withCredentials: true, _skipAuthInterceptor: true } as any
      );
      const access = response.data?.tokens?.access;
      const refresh = response.data?.tokens?.refresh;
      if (!access || jwtTokenType(access) === 'refresh') {
        return false;
      }
      localStorage.setItem('token', access);
      if (refresh && jwtTokenType(refresh) !== 'access') {
        localStorage.setItem('refresh_token', refresh);
      }
      if (response.data?.user) {
        localStorage.setItem('user', JSON.stringify(response.data.user));
      }
      localStorage.setItem('login_timestamp', Date.now().toString());
      return true;
    } catch {
      return false;
    }
  }

  async login(credentials: LoginCredentials) {
    try {
      const response = await api.post('/auth/login/', credentials);
      if (response.data.tokens?.access) {
        localStorage.setItem('token', response.data.tokens.access);
        localStorage.setItem('refresh_token', response.data.tokens.refresh);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        // Sauvegarder aussi la date de connexion pour vérifier l'expiration
        localStorage.setItem('login_timestamp', Date.now().toString());
      }
      return response.data;
    } catch (error: any) {
      // PRIORITÉ 1: Gérer les erreurs WAF (Request blocked by WAF)
      // Ne détecter les erreurs WAF que si c'est vraiment une erreur WAF du backend
      // Vérifier que le message contient explicitement "WAF" ou "blocked by WAF"
      const hasWAFMessage = error.isWAFError || 
                           (error.response?.data?.error?.toLowerCase().includes('waf') || 
                            error.response?.data?.detail?.toLowerCase().includes('waf') ||
                            error.response?.data?.error?.toLowerCase().includes('blocked by waf') ||
                            error.response?.data?.error?.toLowerCase().includes('request blocked by waf') ||
                            error.response?.data?.message?.toLowerCase().includes('waf'));
      
      const isWAFError = (error.response?.status === 403 || error.response?.status === 429) && hasWAFMessage;
      
      if (isWAFError) {
        const wafMessage = error.response?.data?.error || 
                         error.response?.data?.detail || 
                         error.response?.data?.message ||
                         'Votre requête a été bloquée par le système de sécurité (WAF). Veuillez réessayer dans quelques instants ou contactez le support si le problème persiste.';
        throw new Error(wafMessage);
      }
      
      // PRIORITÉ 2: Si erreur 403 SANS message WAF, c'est probablement une restriction de sécurité (tentatives multiples, permissions, etc.)
      if (error.response?.status === 403 && !hasWAFMessage) {
        const errorMessage = error.response?.data?.error || 
                            error.response?.data?.detail || 
                            error.response?.data?.message ||
                            'Accès refusé. Vérifiez vos identifiants ou contactez le support.';
        throw new Error(errorMessage);
      }
      
      // Si erreur 401, identifiants invalides
      if (error.response?.status === 401) {
        const errorMessage = error.response?.data?.error || 
                            error.response?.data?.detail || 
                            'Identifiants invalides. Vérifiez votre email et mot de passe.';
        throw new Error(errorMessage);
      }
      
      // Pour les autres erreurs, les propager avec un message clair
      const errorMessage = error.response?.data?.error || 
                          error.response?.data?.detail || 
                          error.message || 
                          'Erreur lors de la connexion. Veuillez réessayer.';
      throw new Error(errorMessage);
    }
  }

  async register(data: RegisterData) {
    try {
      const response = await api.post('/auth/register/', data);
      if (response.data.tokens?.access) {
        localStorage.setItem('token', response.data.tokens.access);
        localStorage.setItem('refresh_token', response.data.tokens.refresh);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        // Sauvegarder aussi la date de connexion pour vérifier l'expiration
        localStorage.setItem('login_timestamp', Date.now().toString());
      }
      return response.data;
    } catch (error: any) {
      // Gérer les erreurs WAF
      if (error.isWAFError || error.message?.includes('WAF')) {
        throw new Error(error.message || 'Votre requête a été bloquée par le système de sécurité. Veuillez réessayer dans quelques instants.');
      }
      // Gérer les autres erreurs
      const errorMessage = error.response?.data?.error || 
                          error.response?.data?.detail || 
                          error.message || 
                          'Erreur lors de l\'inscription. Veuillez réessayer.';
      throw new Error(errorMessage);
    }
  }

  async logout() {
    try {
      await api.post('/auth/logout/');
    } catch (error: any) {
      // Si le token est expiré (401), c'est normal - on nettoie quand même les tokens côté client
      // Ne pas afficher l'erreur à l'utilisateur car le logout fonctionne de toute façon
      if (error?.response?.status === 401 || error?.response?.status === 403) {
        // Token expiré ou invalide - c'est attendu, on nettoie quand même
        console.debug('Token expiré lors du logout - nettoyage des tokens côté client');
      } else {
        // Autre erreur - on la log mais on nettoie quand même
        console.warn('Erreur lors du logout:', error?.message || error);
      }
    } finally {
      // Toujours nettoyer les tokens, même si le logout a échoué
      localStorage.removeItem('token');
      localStorage.removeItem('refresh_token');
      localStorage.removeItem('user');
      localStorage.removeItem('login_timestamp');
    }
  }

  async getCurrentUser(): Promise<User> {
    const response = await api.get('/auth/me/');
    localStorage.setItem('user', JSON.stringify(response.data));
    return response.data;
  }

  async updateProfile(data: Partial<User>) {
    const response = await api.put('/auth/me/', data);
    localStorage.setItem('user', JSON.stringify(response.data));
    return response.data;
  }

  async updatePassword(data: { current_password: string; password: string; password_confirmation: string }) {
    const response = await api.put('/auth/password/', data);
    return response.data;
  }

  async refreshToken(): Promise<boolean> {
    try {
      const refreshToken = localStorage.getItem('refresh_token');
      if (!refreshToken) {
        console.error('❌ refreshToken: Aucun refresh token trouvé dans localStorage');
        return false;
      }

      // Utiliser une instance axios sans intercepteur pour éviter les boucles infinies
      const axiosInstance = axios.create({
        baseURL: api.defaults.baseURL,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      console.log('🔄 refreshToken: Tentative de rafraîchissement du token...', {
        hasRefreshToken: !!refreshToken,
        refreshTokenLength: refreshToken.length,
        baseURL: api.defaults.baseURL
      });

      const response = await axiosInstance.post('/auth/refresh/', {
        refresh: refreshToken,
      });

      if (response.data.access) {
        localStorage.setItem('token', response.data.access);
        if (response.data.refresh) {
          localStorage.setItem('refresh_token', response.data.refresh);
        }
        console.log('✅ refreshToken: Token rafraîchi avec succès');
        return true;
      }
      console.error('❌ refreshToken: Réponse invalide - pas de token access dans la réponse', response.data);
      return false;
    } catch (error: any) {
      // Refresh token invalide ou expiré
      // Ne pas logger si c'est une erreur 403 ou 401 attendue (token expiré)
      const status = error?.response?.status;
      const isExpectedError = status === 401 || status === 403;
      
      if (!isExpectedError) {
        console.error('❌ refreshToken: Erreur lors du rafraîchissement', {
          error: error,
          message: error?.message,
          response: error?.response?.data,
          status: error?.response?.status,
          statusText: error?.response?.statusText,
          url: error?.config?.url,
        });
      } else {
        console.warn('⚠️ refreshToken: Le refresh token est expiré ou invalide (status: ' + status + '). Veuillez vous reconnecter.');
        // Nettoyer les tokens expirés
        localStorage.removeItem('token');
        localStorage.removeItem('refresh_token');
      }
      return false;
    }
  }

  async quickReconnect(password: string): Promise<boolean> {
    try {
      const storedUser = this.getStoredUser();
      if (!storedUser?.email) {
        throw new Error('Aucun utilisateur trouvé en mémoire');
      }

      // Utiliser une instance axios sans intercepteur pour éviter les boucles infinies
      const axiosInstance = axios.create({
        baseURL: api.defaults.baseURL,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const response = await axiosInstance.post('/auth/quick-reconnect/', {
        email: storedUser.email,
        password: password,
      });

      if (response.data.tokens?.access) {
        localStorage.setItem('token', response.data.tokens.access);
        localStorage.setItem('refresh_token', response.data.tokens.refresh);
        localStorage.setItem('user', JSON.stringify(response.data.user));
        // Sauvegarder aussi la date de connexion pour vérifier l'expiration
        localStorage.setItem('login_timestamp', Date.now().toString());
        return true;
      }
      return false;
    } catch (error: any) {
      // Gérer les erreurs WAF
      if (error.isWAFError || error.message?.includes('WAF')) {
        throw new Error(error.message || 'Votre requête a été bloquée par le système de sécurité. Veuillez réessayer dans quelques instants.');
      }
      // Gérer les autres erreurs
      const errorMessage = error.response?.data?.error || 
                          error.response?.data?.detail || 
                          error.message || 
                          'Erreur lors de la reconnexion. Veuillez réessayer.';
      throw new Error(errorMessage);
    }
  }

  getStoredUser(): User | null {
    if (typeof window === 'undefined') return null; // SSR safety
    const user = localStorage.getItem('user');
    return user ? JSON.parse(user) : null;
  }

  getToken(): string | null {
    if (typeof window === 'undefined') return null; // SSR safety
    repairPressTokenStorage();
    const token = localStorage.getItem('token');
    // Vérifier que le token existe et n'est pas vide
    if (!token || token.trim() === '') {
      return null;
    }
    if (jwtTokenType(token) === 'refresh') {
      return null;
    }
    return token;
  }
  
  /**
   * Vérifie si le token est toujours valide (pas expiré depuis plus de 24h)
   * Cette vérification est basique et ne remplace pas la vérification côté serveur
   */
  isTokenValid(): boolean {
    if (typeof window === 'undefined') return false; // SSR safety
    repairPressTokenStorage();
    const token = this.getToken();
    if (!token) return false;
    if (!isAccessTokenUsable(token)) {
      const refresh = localStorage.getItem('refresh_token');
      return !!(refresh && jwtTokenType(refresh) !== 'access');
    }
    
    // Si on a un token, on considère qu'il est valide
    // La vérification réelle de l'expiration se fait côté serveur
    // On vérifie juste la date de connexion pour éviter les tokens très anciens
    const loginTimestamp = localStorage.getItem('login_timestamp');
    if (loginTimestamp) {
      const loginTime = parseInt(loginTimestamp, 10);
      const now = Date.now();
      // Si la connexion date de plus de 30 jours, considérer le token comme potentiellement expiré
      // (augmenté de 7 à 30 jours pour éviter les déconnexions prématurées)
      // Les tokens JWT expirent généralement après 1h, mais le refresh token peut être valide plus longtemps
      // On laisse le serveur décider de la validité réelle du token
      if (now - loginTime > 30 * 24 * 60 * 60 * 1000) {
        // Token très ancien - nettoyer et retourner false
        this.logout();
        return false;
      }
      
      // Si on vient de se connecter (dans les 5 secondes), ne pas vérifier l'expiration
      // pour éviter les problèmes de timing
      if (now - loginTime < 5000) {
        return true;
      }
    }
    
    // Si on a un token et qu'il n'est pas trop ancien, on considère qu'il est valide
    // La vérification réelle se fera côté serveur lors des requêtes
    return true;
  }

  isAuthenticated(): boolean {
    if (typeof window === 'undefined') return false; // SSR safety
    // Vérifier que le token existe et est valide
    return this.isTokenValid();
  }

  isSuperAdmin(): boolean {
    if (typeof window === 'undefined') return false; // SSR safety
    const user = this.getStoredUser();
    if (!user) return false;
    if ((user as any).role === 'super-admin') return true;
    if (!user.roles) return false;
    return user.roles.some((role: any) => {
      const roleValue = typeof role === 'string' ? role : role.name || role.role;
      return roleValue === 'super-admin';
    });
  }

  isTenantAdmin(): boolean {
    if (typeof window === 'undefined') return false; // SSR safety
    const user = this.getStoredUser();
    if (!user) return false;
    if ((user as any).role === 'tenant-admin') return true;
    if (!user.roles) return false;
    return user.roles.some((role: any) => {
      const roleValue = typeof role === 'string' ? role : role.name || role.role;
      return roleValue === 'tenant-admin';
    });
  }

  /**
   * Sauvegarde l'URL actuelle avant de rediriger vers /login
   * Cette URL sera restaurée après la reconnexion
   */
  saveRedirectUrl(): void {
    if (typeof window === 'undefined') return; // SSR safety
    const url = new URL(window.location.href);
    // Supprimer les paramètres sensibles (email, password) de l'URL avant de sauvegarder
    url.searchParams.delete('email');
    url.searchParams.delete('password');
    const currentPath = url.pathname + url.search;
    // Ne pas sauvegarder si on est déjà sur /login ou /register
    if (currentPath.startsWith('/login') || currentPath.startsWith('/register')) {
      return;
    }
    sessionStorage.setItem('redirect_after_login', currentPath);
  }

  /**
   * Récupère et supprime l'URL de redirection sauvegardée
   * @returns L'URL à restaurer ou null si aucune URL n'a été sauvegardée
   */
  getAndClearRedirectUrl(): string | null {
    if (typeof window === 'undefined') return null; // SSR safety
    const redirectUrl = sessionStorage.getItem('redirect_after_login');
    if (redirectUrl) {
      sessionStorage.removeItem('redirect_after_login');
      return redirectUrl;
    }
    return null;
  }
}

export default new AuthService();

