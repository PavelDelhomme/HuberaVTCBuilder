'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter, useParams } from 'next/navigation'
import authService from '@/services/auth.service'
import AdminLayout from '@/components/admin/AdminLayout'
import projectService, { Project, ProjectPage } from '@/services/project.service'
import api from '@/lib/api'
import toast from 'react-hot-toast'
import PageLoader from '@/components/shared/PageLoader'
import BlockPreview from '@/components/editor/BlockPreview'
import blocksService from '@/services/blocks.service'
import { useNavigationLoading } from '@/hooks/useNavigationLoading'
import ToggleSwitch from '@/components/shared/ToggleSwitch'
import { ALL_PUBLIC_PAGES, createPageInSystem } from '@/scripts/create-public-pages'
import { huberaLandingUrl } from '@/lib/huberaLandingUrl'

export default function ProjectDetailPage() {
  const router = useRouter()
  const params = useParams()
  // Support ID (number), slug (string), or UUID for project identification
  const projectIdentifier = params?.id as string
  // UUID pattern: 8-4-4-4-12 hexadecimal characters
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectIdentifier)
  const projectId = /^\d+$/.test(projectIdentifier) ? parseInt(projectIdentifier) : null
  const projectSlug = (projectId === null && !isUuid) ? projectIdentifier : null
  const projectUuid = isUuid ? projectIdentifier : null
  const [project, setProject] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const { isNavigating, navigate } = useNavigationLoading()
  const [publicPages, setPublicPages] = useState<any[]>([])
  const [tenantPages, setTenantPages] = useState<any[]>([])
  const [previewPage, setPreviewPage] = useState<{ slug: string; blocks: any[]; title: string } | null>(null)
  const [blockTypes, setBlockTypes] = useState<any[]>([])
  const [loadingPreview, setLoadingPreview] = useState(false)
  const [searchQuery, setSearchQuery] = useState<string>('')
  const [creatingSubPage, setCreatingSubPage] = useState<string | null>(null)
  const [subPageName, setSubPageName] = useState<string>('')
  const [expandedPages, setExpandedPages] = useState<Set<number>>(new Set()) // Pages avec sous-pages dépliées
  const [draggedPageId, setDraggedPageId] = useState<number | null>(null)

  // Ref pour éviter les exécutions multiples du nettoyage (désactivé - nettoyage automatique supprimé)
  // const cleanupExecutedRef = useRef(false)

  useEffect(() => {
    const loadData = async () => {
      if (!authService.isSuperAdmin()) {
        router.push('/dashboard')
        return
      }
      
      // Vérifier si on vient de se connecter (dans les 5 secondes)
      const loginTimestamp = localStorage.getItem('login_timestamp');
      const justLoggedIn = loginTimestamp && (Date.now() - parseInt(loginTimestamp, 10)) < 5000;
      
      if (justLoggedIn) {
        // Attendre un peu avant de charger les données après le login
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      if (projectId || projectSlug || projectUuid) {
        // Charger les données de manière SÉRIELLE pour éviter le rate limiting WAF
        await loadProject()
        await new Promise(resolve => setTimeout(resolve, 500));
        await loadBlockTypes()
      }
    }
    loadData()
  }, [projectId, projectSlug, projectUuid]) // Retirer 'router' des dépendances pour éviter les re-renders

  // Load available pages when project is loaded
  useEffect(() => {
    if (project) {
      loadAvailablePages()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, project?.is_system_project, project?.tenant_id])

  // Nettoyage automatique DÉSACTIVÉ
  // Le nettoyage automatique qui retirait toutes les pages sauf "home" et "test" 
  // du projet système a été désactivé pour permettre d'ajouter librement des pages
  // à tous les projets, y compris le projet système.
  // 
  // Si tu veux nettoyer manuellement, utilise le bouton "Nettoyer" dans l'interface.
  // 
  // useEffect(() => {
  //   if (!projectId || projectId !== 1 || cleanupExecutedRef.current || !project || loading) {
  //     return
  //   }
  //   // ... code de nettoyage désactivé
  // }, [projectId, project, loading])

  const loadBlockTypes = async () => {
    try {
      const types = await blocksService.getBlockTypes()
      setBlockTypes(Array.isArray(types) ? types : [])
    } catch (error) {
      console.error('Error chargement types de blocs:', error)
    }
  }

  const loadProject = async () => {
    try {
      setLoading(true)
      let data: Project
      if (projectId) {
        // Load by ID (legacy support)
        data = await projectService.getById(projectId)
      } else if (projectUuid) {
        // Load by UUID
        const found = await projectService.getByUuid(projectUuid)
        if (!found) {
          throw new Error('Projet introuvable')
        }
        data = found
      } else if (projectSlug) {
        // Load by slug
        const found = await projectService.getBySlug(projectSlug)
        if (!found) {
          throw new Error('Projet introuvable')
        }
        data = found
      } else {
        throw new Error('Identifiant de projet invalide')
      }
      setProject(data)
    } catch (error: any) {
      console.error('Error chargement projet:', error)
      toast.error('Error lors du chargement du projet')
      router.push('/admin/projects')
    } finally {
      setLoading(false)
    }
  }

  const loadAvailablePages = async () => {
    try {
      // Only load public pages if this is a system project
      if (project?.is_system_project) {
        const settingsResponse = await api.get('/system-settings/')
        const settings = settingsResponse.data
        const allPages: any[] = []
        
        // Homepage
        if (settings.public_homepage_blocks !== undefined) {
          allPages.push({
            slug: 'home',
            title: 'Page d\'accueil',
            type: 'public',
            is_active: true, // Homepage is always active
          })
        }
        
        // Other public pages
        const publicPagesData = settings.public_pages || {}
        Object.entries(publicPagesData).forEach(([slug, pageData]: [string, any]) => {
          // Ensure slug is properly formatted (handle nested pages like "docs/configuration")
          const normalizedSlug = slug.trim()
          allPages.push({
            slug: normalizedSlug,
            title: pageData?.title || normalizedSlug.split('/').pop() || normalizedSlug, // Use last part of slug as fallback title
            type: 'public',
            is_active: pageData?.is_active !== false, // Default to true if not specified
          })
        })
        
        // Load projects where each page is linked (excluding current project)
        // Charger de manière SÉRIELLE pour éviter le rate limiting WAF
        const pagesWithProjects: any[] = []
        for (const page of allPages) {
          try {
            // Use query parameter instead of URL path to handle slashes (e.g., "legal/terms")
            const response = await api.get(`/projects/page-projects/?page_slug=${encodeURIComponent(page.slug)}&page_type=public`)
            const otherProjects = response.data.projects.filter(
              (p: any) => p.id !== project?.id
            )
            pagesWithProjects.push({
              ...page,
              otherProjects: otherProjects,
            })
          } catch (error: any) {
            // Si l'endpoint n'existe pas encore ou erreur, retourner la page sans projets
            // Ne logger que les erreurs non-404/403 (404/403 sont normaux si la page n'est dans aucun projet ou si pas de permissions)
            if (error.response?.status !== 404 && error.response?.status !== 403) {
              console.warn(`Error chargement projets pour page ${page.slug}:`, error.response?.status || error.message)
            }
            // Pour les erreurs 403, on retourne quand même la page sans projets (silencieusement)
            pagesWithProjects.push({
              ...page,
              otherProjects: [],
            })
          }
          
          // Attendre 300ms avant la prochaine requête pour éviter le rate limiting
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        setPublicPages(pagesWithProjects)
      } else {
        // Clear public pages for non-system projects
        setPublicPages([])
      }
      
      // Load tenant pages if project has a tenant
      if (project?.tenant_id) {
        try {
          const pageService = (await import('@/services/page.service')).default
          const tenantPagesData = await pageService.getAll({ tenant_id: project.tenant_id })
          setTenantPages(tenantPagesData.map((page: any) => ({
            slug: page.slug,
            title: page.title,
            type: 'tenant',
            id: page.id,
            is_active: page.status === 'published',
          })))
        } catch (error: any) {
          console.error('Error chargement pages tenant:', error)
          setTenantPages([])
        }
      } else {
        // Clear tenant pages for system projects
        setTenantPages([])
      }
    } catch (error: any) {
      console.error('Error chargement pages disponibles:', error)
      setPublicPages([])
      setTenantPages([])
    }
  }

  const handleAddPage = async (pageSlug: string, pageType: 'public' | 'tenant') => {
    try {
      await projectService.addPage(project.id, pageSlug, pageType)
      toast.success('Page ajoutée au projet !')
      loadProject()
      loadAvailablePages() // Recharger les pages disponibles
    } catch (error: any) {
      console.error('Error ajout page:', error)
      const errorMessage = error.response?.data?.error || 
                           error.response?.data?.message || 
                           'Error lors de l\'ajout de la page'
      
      // Afficher un message d'error plus détaillé
      if (error.response?.data?.existing_project_name) {
        toast.error(
          `${errorMessage}\n\nCette page est déjà dans le projet "${error.response.data.existing_project_name}" (ID: ${error.response.data.existing_project_id}).`,
          { duration: 6000 }
        )
      } else {
        toast.error(errorMessage)
      }
    }
  }

  const handleRemovePage = async (pageId: number) => {
    try {
      // Trouver la page à retirer dans le projet
      const pageToRemove = project?.pages?.find((p: ProjectPage) => p.id === pageId)
      if (!pageToRemove) {
        toast.error('Page introuvable dans le projet')
        return
      }

      const pageSlug = pageToRemove.page_slug
      const slugParts = pageSlug.split('/')
      const isSubPage = slugParts.length > 1

      if (isSubPage) {
        // C'est une sous-page : retirer uniquement cette sous-page
        await projectService.removePage(project.id, pageId)
        toast.success('Sous-page retirée du projet !')
      } else {
        // C'est une page principale : retirer la page principale ET toutes ses sous-pages
        const parentSlug = slugParts[0]
        
        // Trouver toutes les sous-pages de cette page principale
        const subPages = project?.pages?.filter((p: ProjectPage) => {
          const pSlugParts = p.page_slug.split('/')
          return pSlugParts.length > 1 && pSlugParts[0] === parentSlug
        }) || []

        // Retirer toutes les sous-pages d'abord
        for (const subPage of subPages) {
          try {
            await projectService.removePage(project.id, subPage.id)
          } catch (error: any) {
            console.warn(`Error retrait sous-page ${subPage.page_slug}:`, error)
          }
        }

        // Puis retirer la page principale
        await projectService.removePage(project.id, pageId)

        const totalRemoved = 1 + subPages.length
        if (subPages.length > 0) {
          toast.success(`Page principale et ${subPages.length} sous-page(s) retirée(s) du projet !`)
        } else {
          toast.success('Page retirée du projet !')
        }
      }

      loadProject()
      loadAvailablePages() // Recharger les pages disponibles
    } catch (error: any) {
      console.error('Error retrait page:', error)
      toast.error('Error lors du retrait de la page')
    }
  }

  const handleDeletePage = async (pageSlug: string) => {
    if (!authService.isSuperAdmin()) {
      toast.error('Seuls les administrateurs peuvent supprimer des pages')
      return
    }
    
    if (!confirm(`Êtes-vous sûr de vouloir supprimer définitivement la page "${pageSlug}" ?\n\nCette action est irréversible et la page sera supprimée de tous les projets.`)) {
      return
    }
    
    try {
      const settingsResponse = await api.get('/system-settings/')
      const settings = settingsResponse.data
      const publicPages = settings.public_pages || {}
      
      // Supprimer la page
      delete publicPages[pageSlug]
      
      // Sauvegarder
      await api.patch('/system-settings/', { public_pages: publicPages })
      
      toast.success(`Page "${pageSlug}" supprimée !`)
      loadAvailablePages()
      loadProject()
    } catch (error: any) {
      console.error('Error suppression page:', error)
      toast.error(error.response?.data?.error || 'Error lors de la suppression de la page')
    }
  }

  // Fonction pour organiser les pages par hiérarchie
  const organizePagesByHierarchy = (pages: ProjectPage[]) => {
    const organized: { parent: ProjectPage | null; children: ProjectPage[] }[] = []
    const processed = new Set<number>()
    
    // Séparer les pages publiques et tenant
    const publicPagesList = pages.filter(p => p.page_type === 'public')
    const tenantPagesList = pages.filter(p => p.page_type === 'tenant')
    
    // Organiser les pages publiques (avec hiérarchie)
    const sortedPublicPages = [...publicPagesList].sort((a, b) => a.page_slug.localeCompare(b.page_slug))
    
    // D'abord, traiter toutes les pages principales (sans slash)
    sortedPublicPages.forEach((page) => {
      if (processed.has(page.id)) return
      
      const slugParts = page.page_slug.split('/')
      
      // Si c'est une page principale (pas de sous-page)
      if (slugParts.length === 1) {
        // Trouver toutes les sous-pages de cette page
        const children = sortedPublicPages.filter((p) => {
          if (processed.has(p.id)) return false
          const childSlugParts = p.page_slug.split('/')
          return (
            childSlugParts.length > 1 &&
            childSlugParts[0] === slugParts[0]
          )
        })
        
        children.forEach((child) => processed.add(child.id))
        processed.add(page.id)
        
        organized.push({
          parent: page,
          children: children.sort((a, b) => a.page_slug.localeCompare(b.page_slug)),
        })
      }
    })
    
    // Ensuite, traiter les sous-pages orphelines (sous-pages dont le parent n'existe pas dans le projet)
    sortedPublicPages.forEach((page) => {
      if (processed.has(page.id)) return
      
      const slugParts = page.page_slug.split('/')
      
      // C'est une sous-page orpheline (pas de parent dans le projet)
      // On la traite comme une page principale avec ses propres sous-pages potentielles
      if (slugParts.length > 1) {
        // Chercher si d'autres sous-pages partagent le même préfixe parent
        const parentPrefix = slugParts[0]
        const orphanSiblings = sortedPublicPages.filter((p) => {
          if (processed.has(p.id)) return false
          const pSlugParts = p.page_slug.split('/')
          return (
            pSlugParts.length > 1 &&
            pSlugParts[0] === parentPrefix
          )
        })
        
        // Si on trouve des sœurs, créer un groupe virtuel avec la première comme parent
        if (orphanSiblings.length > 0) {
          // Trier par slug pour avoir un ordre cohérent
          orphanSiblings.sort((a, b) => a.page_slug.localeCompare(b.page_slug))
          
          // La première devient le parent virtuel, les autres sont ses enfants
          const virtualParent = orphanSiblings[0]
          const virtualChildren = orphanSiblings.slice(1)
          
          virtualChildren.forEach((child) => processed.add(child.id))
          processed.add(virtualParent.id)
          
          organized.push({
            parent: virtualParent,
            children: virtualChildren,
          })
        } else {
          // Pas de sœurs, traiter comme page principale isolée
          processed.add(page.id)
          organized.push({
            parent: page,
            children: [],
          })
        }
      }
    })
    
    // Ajouter les pages tenant (pas de hiérarchie pour l'instant, juste l'ordre)
    const sortedTenantPages = [...tenantPagesList].sort((a, b) => {
      // Trier par order si disponible, sinon par ID
      if (a.order !== undefined && b.order !== undefined) {
        return a.order - b.order
      }
      return parseInt(a.page_slug) - parseInt(b.page_slug)
    })
    
    sortedTenantPages.forEach((page) => {
      organized.push({
        parent: page,
        children: [],
      })
    })
    
    return organized
  }

  // Fonction pour créer une sous-page
  const handleCreateSubPage = async (parentSlug: string) => {
    if (!subPageName.trim()) {
      toast.error('Veuillez entrer un nom pour la sous-page')
      return
    }
    
    // Nettoyer le nom pour créer un slug valide
    const cleanName = subPageName.trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    
    if (!cleanName) {
      toast.error('Le nom de la sous-page n\'est pas valide')
      return
    }
    
    const newSlug = `${parentSlug}/${cleanName}`
    
    try {
      // Vérifier si la sous-page existe déjà
      const settingsResponse = await api.get('/system-settings/')
      const publicPages = settingsResponse.data.public_pages || {}
      
      if (publicPages[newSlug]) {
        toast.error(`La sous-page "${newSlug}" existe déjà`)
        return
      }
      
      // Créer la nouvelle sous-page
      publicPages[newSlug] = {
        title: subPageName.trim(),
        blocks: [],
        meta_title: `${subPageName.trim()} - ${publicPages[parentSlug]?.title || parentSlug}`,
        meta_description: '',
        is_active: true,
        order: Object.keys(publicPages).length + 1,
      }
      
      // Sauvegarder
      await api.patch('/system-settings/', { public_pages: publicPages })
      
      toast.success(`Sous-page "${newSlug}" créée !`)
      
      // Recharger les pages
      loadAvailablePages()
      
      // Ajouter automatiquement au projet
      await projectService.addPage(projectId, newSlug, 'public')
      toast.success('Sous-page ajoutée au projet !')
      loadProject()
      
      // Réinitialiser
      setCreatingSubPage(null)
      setSubPageName('')
    } catch (error: any) {
      console.error('Error création sous-page:', error)
      toast.error(error.response?.data?.error || 'Error lors de la création de la sous-page')
    }
  }

  const handleDuplicatePage = async (pageSlug: string) => {
    try {
      const settingsResponse = await api.get('/system-settings/')
      const settings = settingsResponse.data
      const publicPages = settings.public_pages || {}
      
      if (!publicPages[pageSlug]) {
        toast.error('Page introuvable')
        return
      }
      
      // Trouver un nouveau slug disponible
      let newSlug = `${pageSlug}-copie`
      let counter = 1
      while (publicPages[newSlug]) {
        newSlug = `${pageSlug}-copie-${counter}`
        counter++
      }
      
      // Dupliquer la page
      const originalPage = publicPages[pageSlug]
      publicPages[newSlug] = {
        ...originalPage,
        title: `${originalPage.title} (Copie)`,
      }
      
      // Sauvegarder
      await api.patch('/system-settings/', { public_pages: publicPages })
      
      toast.success(`Page dupliquée : "${newSlug}"`)
      loadAvailablePages()
      
      // Ajouter automatiquement la page dupliquée au projet actuel
      await projectService.addPage(projectId, newSlug, 'public')
      toast.success('Page dupliquée ajoutée au projet !')
      loadProject()
    } catch (error: any) {
      console.error('Error duplication page:', error)
      toast.error(error.response?.data?.error || 'Error lors de la duplication de la page')
    }
  }

  const handleToggleActive = async (page: ProjectPage) => {
    try {
      await projectService.updatePage(project.id, page.id, { is_active: !page.is_active })
      toast.success(`Page ${!page.is_active ? 'affichée' : 'masquée'} dans le projet`)
      loadProject()
    } catch (error: any) {
      console.error('Error mise à jour page:', error)
      toast.error('Error lors de la mise à jour')
    }
  }

  const handleTogglePublished = async (pageSlug: string, currentStatus: boolean) => {
    try {
      const settingsResponse = await api.get('/system-settings/')
      const settings = settingsResponse.data
      const publicPages = settings.public_pages || {}
      
      if (pageSlug === 'home') {
        toast('La page d\'accueil est toujours publiée')
        return
      }
      
      if (publicPages[pageSlug]) {
        publicPages[pageSlug].is_active = !currentStatus
        await api.patch('/system-settings/', { public_pages: publicPages })
        toast.success(`Page ${!currentStatus ? 'publiée' : 'dépubliée'}`)
        loadAvailablePages()
        loadProject()
      }
    } catch (error: any) {
      console.error('Error toggle published:', error)
      toast.error('Error lors de la modification')
    }
  }

  // Fonction générique pour afficher l'aperçu d'une page par son slug
  const handlePreviewPage = async (pageSlug: string, pageType: 'public' | 'tenant' = 'public') => {
    try {
      setLoadingPreview(true)
      
      // Charger les données de la page
      if (pageType === 'public') {
        const settingsResponse = await api.get('/system-settings/')
        const settings = settingsResponse.data
        
        let pageData: any = null
        
        // Vérifier si c'est la homepage
        if (pageSlug === 'home') {
          const homepageBlocks = settings.public_homepage_blocks
          pageData = {
            title: 'Page d\'accueil',
            blocks: Array.isArray(homepageBlocks) ? homepageBlocks : [],
          }
        } else {
          // Chercher dans public_pages
          const publicPages = settings.public_pages || {}
          if (publicPages[pageSlug]) {
            const pageBlocks = publicPages[pageSlug].blocks
            pageData = {
              title: publicPages[pageSlug].title || pageSlug,
              blocks: Array.isArray(pageBlocks) ? pageBlocks : [],
            }
          }
        }
        
        if (pageData) {
          setPreviewPage({
            slug: pageSlug,
            blocks: pageData.blocks,
            title: pageData.title,
          })
        } else {
          toast.error('Page non trouvée')
        }
      } else {
        // Load tenant page
        try {
          const pageService = (await import('@/services/page.service')).default
          
          // Get tenant_id from project
          if (!project?.tenant_id) {
            toast.error('Impossible de charger la page : tenant non trouvé')
            return
          }
          
          // pageSlug can be:
          // - Old format: just page ID (e.g., "1")
          // - New format: tenant_id:page_id (e.g., "5:1")
          let pageId: number
          if (pageSlug.includes(':')) {
            // New format: tenant_id:page_id
            const [, id] = pageSlug.split(':')
            pageId = parseInt(id)
          } else {
            // Old format: just page ID
            pageId = parseInt(pageSlug)
          }
          
          const pageData = await pageService.getById(pageId, project.tenant_id)
          
          if (pageData) {
            setPreviewPage({
              slug: pageSlug,
              blocks: Array.isArray(pageData.blocks) ? pageData.blocks : [],
              title: pageData.title,
            })
          } else {
            toast.error('Page non trouvée')
          }
        } catch (error: any) {
          console.error('Error chargement page tenant:', error)
          toast.error(error.response?.data?.error || 'Error lors du chargement de la page tenant')
        }
      }
    } catch (error: any) {
      console.error('Error chargement prévisualisation:', error)
      toast.error('Error lors du chargement de la prévisualisation')
    } finally {
      setLoadingPreview(false)
    }
  }

  if (loading || isNavigating || !project) {
    return (
      <AdminLayout title="Projet" subtitle="Chargement...">
        <PageLoader text={isNavigating ? "Chargement..." : "Chargement du projet..."} />
      </AdminLayout>
    )
  }

  const handleEditProject = () => {
    if (!project.pages || project.pages.length === 0) {
      toast.error('Ce projet n\'a pas encore de pages. Ajoutez d\'abord une page au projet.')
      return
    }
    
    // Trouver la première page active, sinon la première page
    const firstActivePage = project.pages.find((p: ProjectPage) => p.is_active) || project.pages[0]
    
    if (firstActivePage.page_type === 'public') {
      navigate(`/admin/pages-public/edit/${firstActivePage.page_slug}?projectId=${project.uuid || project.slug}`)
    } else {
      toast('L\'édition des pages tenant n\'est pas encore disponible', { icon: 'ℹ️' })
    }
  }

  return (
    <AdminLayout
      title={project.name}
      subtitle={
        project.metadata?.kind === 'hubera-product-landing' && project.domain
          ? `Landing ${project.domain}`
          : `Gérer les pages du projet ${project.slug}`
      }
      headerActions={
        <button
          onClick={handleEditProject}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 font-medium"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          Éditer le projet
        </button>
      }
    >
      <div className="space-y-6">
        {/* Project Info */}
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-4">Informations du Projet</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Nom
              </label>
              <input
                type="text"
                value={project.name}
                onChange={(e) => {
                  setProject({ ...project, name: e.target.value })
                }}
                onBlur={async () => {
                  try {
                    await projectService.update(project.id, { name: project.name })
                    toast.success('Projet mis à jour !')
                  } catch (error) {
                    toast.error('Error lors de la mise à jour')
                    loadProject()
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
            </div>
            {project.metadata?.kind === 'hubera-product-landing' && project.domain && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Domaine
                </label>
                <p className="px-3 py-2 text-gray-900 dark:text-gray-100">{project.domain}</p>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Statut du Projet
              </label>
              <select
                value={project.status}
                onChange={async (e) => {
                  try {
                    await projectService.update(project.id, { status: e.target.value as any })
                    setProject({ ...project, status: e.target.value as any })
                    toast.success('Statut mis à jour !')
                  } catch (error) {
                    toast.error('Error lors de la mise à jour')
                  }
                }}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                title={
                  project.status === 'active' 
                    ? 'Le projet est en ligne et accessible' 
                    : project.status === 'inactive'
                    ? 'Le projet est temporairement désactivé (non accessible)'
                    : 'Le projet est archivé (conservé mais non accessible)'
                }
              >
                <option value="active">🟢 En ligne - Site accessible</option>
                <option value="inactive">🟡 Hors ligne - Site non accessible</option>
                <option value="archived">🔴 Archivé - Projet conservé mais non accessible</option>
              </select>
              <div className="mt-2 p-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800">
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  <strong className="text-gray-700 dark:text-gray-300">💡 Explication :</strong>
                  <br />
                  <span className="text-green-700 dark:text-green-300">🟢 En ligne</span> = Le site est accessible et fonctionne normalement
                  <br />
                  <span className="text-yellow-700 dark:text-yellow-300">🟡 Hors ligne</span> = Le site est temporairement désactivé (maintenance, pause, etc.)
                  <br />
                  <span className="text-red-700 dark:text-red-300">🔴 Archivé</span> = Le projet est conservé mais plus accessible (ancien projet, terminé, etc.)
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Gestion des Pages - Deux Sections */}
        <div className="space-y-6">
          {/* Section 1: Pages liées au projet */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                  <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Pages liées au projet
                  {project.pages && project.pages.length > 0 && (() => {
                    const organizedPages = organizePagesByHierarchy(project.pages)
                    const mainPagesCount = organizedPages.length
                    const totalPagesCount = project.pages.length
                    return (
                      <span className="ml-2 px-2 py-1 bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 rounded-full text-sm font-medium">
                        {mainPagesCount} page{mainPagesCount > 1 ? 's' : ''} principale{mainPagesCount > 1 ? 's' : ''}
                        {totalPagesCount > mainPagesCount && (
                          <span className="ml-1 text-xs">({totalPagesCount} au total avec sous-pages)</span>
                        )}
                      </span>
                    )
                  })()}
                </h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                  Pages actuellement liées à ce projet et affichées sur le site
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* Bouton d'initialisation des pages (uniquement pour les projets système) */}
                {project.is_system_project && (
                  <button
                    onClick={async () => {
                      if (!confirm(`Voulez-vous initialiser toutes les pages publiques avec leurs blocs par défaut ?\n\nCela créera/remplacera les pages suivantes :\n${ALL_PUBLIC_PAGES.map(p => `- ${p.slug} (${p.title})`).join('\n')}\n\n⚠️ Attention : Les pages existantes seront remplacées.`)) {
                        return
                      }
                      
                      try {
                        toast.loading('Initialisation des pages...', { id: 'init-pages' })
                        
                        const results = []
                        for (let i = 0; i < ALL_PUBLIC_PAGES.length; i++) {
                          const page = ALL_PUBLIC_PAGES[i]
                          // Créer la page dans system-settings
                          const result = await createPageInSystem(page, api)
                          results.push(result)
                          
                          // Si la création a réussi, lier la page au projet
                          if (result.success && project && project.id) {
                            try {
                              console.log(`Liaison de la page ${page.slug} au projet ${project.id}...`)
                              await projectService.addPage(project.id, page.slug, 'public', i + 1)
                              console.log(`✅ Page ${page.slug} liée au projet avec succès`)
                            } catch (linkError: any) {
                              // Si la page est déjà liée, c'est OK (l'API retourne 200 dans ce cas)
                              if (linkError.response?.status === 200) {
                                console.log(`ℹ️ Page ${page.slug} déjà liée au projet`)
                              } else if (linkError.response?.status === 400 && linkError.response?.data?.error?.includes('already')) {
                                console.log(`ℹ️ Page ${page.slug} déjà liée au projet (400 avec message 'already')`)
                              } else {
                                console.error(`❌ Erreur lors de la liaison de la page ${page.slug} au projet:`, linkError)
                                // Ne pas échouer complètement, juste logger l'erreur
                              }
                            }
                          } else {
                            console.warn(`⚠️ Impossible de lier la page ${page.slug}: project=${project ? 'exists' : 'null'}, project.id=${project?.id || 'undefined'}`)
                          }
                        }
                        
                        const successCount = results.filter(r => r.success).length
                        const failCount = results.filter(r => !r.success).length
                        
                        toast.dismiss('init-pages')
                        
                        if (failCount === 0) {
                          toast.success(`${successCount} page${successCount > 1 ? 's' : ''} initialisée${successCount > 1 ? 's' : ''} avec succès !`)
                        } else {
                          toast.success(`${successCount} page${successCount > 1 ? 's' : ''} créée${successCount > 1 ? 's' : ''}, ${failCount} erreur${failCount > 1 ? 's' : ''}`)
                        }
                        
                        // Recharger les pages disponibles ET le projet pour voir les nouvelles pages
                        await loadAvailablePages()
                        await loadProject()
                      } catch (error: any) {
                        toast.dismiss('init-pages')
                        console.error('Error initialisation pages:', error)
                        toast.error('Error lors de l\'initialisation des pages')
                      }
                    }}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-2 text-sm font-medium"
                    title="Initialiser toutes les pages publiques avec leurs blocs par défaut"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                    </svg>
                    Initialiser les pages
                  </button>
                )}
                {project.pages && project.pages.length > 2 && (
                  <button
                    onClick={async () => {
                      if (confirm(`Voulez-vous retirer toutes les pages sauf "home" et "test" ?\n\n${project.pages.length - 2} page(s) seront retirées.`)) {
                        try {
                          const pagesToRemove = project.pages.filter(
                            (p: ProjectPage) => p.page_slug !== 'home' && p.page_slug !== 'test'
                          )
                          
                          for (const page of pagesToRemove) {
                            await projectService.removePage(project.id, page.id)
                          }
                          
                          toast.success(`${pagesToRemove.length} page(s) retirée(s) avec succès !`)
                          loadProject()
                        } catch (error: any) {
                          console.error('Error nettoyage:', error)
                          toast.error('Error lors du nettoyage des pages')
                        }
                      }
                    }}
                    className="px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors flex items-center gap-2 text-sm"
                    title="Retirer toutes les pages sauf home et test"
                  >
                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                    Nettoyer
                  </button>
                )}
                <button
                  onClick={async () => {
                    try {
                      // Récupérer les pages existantes pour trouver le prochain numéro
                      const currentSettings = await api.get('/system-settings/')
                      const publicPages = currentSettings.data.public_pages || {}
                      
                      // Trouver le prochain numéro disponible
                      let pageNumber = 1
                      let newSlug = `nouvelle-page-${pageNumber}`
                      while (publicPages[newSlug]) {
                        pageNumber++
                        newSlug = `nouvelle-page-${pageNumber}`
                      }
                      
                      // Créer la nouvelle page avec un nom automatique
                      const newPageTitle = `Nouvelle page ${pageNumber}`
                      publicPages[newSlug] = {
                        title: newPageTitle,
                        blocks: [],
                        meta_title: '',
                        meta_description: '',
                        is_active: true,
                        order: Object.keys(publicPages).length + 1,
                      }
                      
                      // Sauvegarder la nouvelle page
                      await api.patch('/system-settings/', { public_pages: publicPages })
                      
                      toast.success(`Page "${newPageTitle}" créée ! Vous pouvez maintenant l'ajouter au projet si nécessaire.`)
                      
                      // Recharger les pages disponibles
                      loadAvailablePages()
                      
                      // Naviguer vers l'éditeur de la nouvelle page
                      navigate(`/admin/pages-public/edit/${newSlug}?projectId=${project.uuid || project.slug}`)
                    } catch (error: any) {
                      console.error('Error création nouvelle page:', error)
                      toast.error(error.response?.data?.error || 'Error lors de la création de la nouvelle page')
                    }
                  }}
                  className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors flex items-center gap-2 text-sm"
                >
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Page
                </button>
              </div>
            </div>
            
            {/* Liste des pages liées - Organisées par hiérarchie */}
            {project.pages && project.pages.length > 0 ? (
              <div className="space-y-3">
                {organizePagesByHierarchy(project.pages).map(({ parent, children }) => {
                  // Find page data based on page_type
                  let parentPage: any = null
                  if (parent.page_type === 'public') {
                    // Try exact match first
                    parentPage = publicPages.find((p: any) => p.slug === parent.page_slug)
                    // If not found, try with trimmed slug (in case of whitespace issues)
                    if (!parentPage) {
                      parentPage = publicPages.find((p: any) => p.slug?.trim() === parent.page_slug?.trim())
                    }
                  } else if (parent.page_type === 'tenant') {
                    // For tenant pages, page_slug can be:
                    // - Old format: just page ID (e.g., "1")
                    // - New format: tenant_id:page_id (e.g., "5:1")
                    let pageId: number
                    if (parent.page_slug.includes(':')) {
                      // New format: tenant_id:page_id
                      const [, id] = parent.page_slug.split(':')
                      pageId = parseInt(id)
                    } else {
                      // Old format: just page ID
                      pageId = parseInt(parent.page_slug)
                    }
                    parentPage = tenantPages.find((p: any) => p.id === pageId)
                  }
                  
                  if (!parentPage) {
                    // Page not found in available pages - use page_slug as fallback
                    // This can happen if the page was just created and loadAvailablePages hasn't refreshed yet
                    parentPage = {
                      slug: parent.page_slug,
                      title: parent.page_slug.split('/').pop() || parent.page_slug, // Use last part of slug as title
                      is_active: true, // Default to active
                      type: parent.page_type,
                    }
                  }
                  
                  const isPublished = parentPage.is_active !== false
                  const isSubPage = parent.page_slug.includes('/')
                  
                  // Fonction pour naviguer vers l'édition de la page
                  const handlePageClick = () => {
                    if (parent.page_type === 'public') {
                      if (parentPage.slug === 'home') {
                        navigate(`/admin/pages-public/edit/home?projectId=${project.uuid || project.slug}`)
                      } else {
                        navigate(`/admin/pages-public/edit/${parentPage.slug}?projectId=${project.uuid || project.slug}`)
                      }
                    } else if (parent.page_type === 'tenant') {
                      // Navigate to tenant page editor
                      navigate(`/dashboard/pages/${parentPage.id}/edit`)
                    }
                  }
                  
                  return (
                    <div key={parent.id} className="space-y-2">
                      {/* Page principale ou sous-page orpheline */}
                      <div
                        onClick={handlePageClick}
                        className={`flex items-center justify-between p-3 sm:p-4 rounded-lg border cursor-pointer transition-all group ${
                          isSubPage
                            ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800 hover:bg-purple-100 dark:hover:bg-purple-900/30 ml-6'
                            : 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/30'
                        }`}
                        title="Double-cliquer pour éditer"
                      >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        {/* Indicateur de hiérarchie pour les sous-pages */}
                        {isSubPage && (
                          <div className="flex-shrink-0 text-purple-600 dark:text-purple-400">
                            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </div>
                        )}
                        
                        {/* Toggle Publié */}
                        {parent.page_type === 'public' && (
                          <div onClick={(e) => e.stopPropagation()} className="flex flex-col items-center gap-1">
                            <ToggleSwitch
                              checked={isPublished}
                              onChange={() => handleTogglePublished(parentPage.slug, isPublished)}
                              size="sm"
                              color="green"
                            />
                            <span className="text-xs text-gray-500 dark:text-gray-400">Publié</span>
                          </div>
                        )}
                        {parent.page_type === 'tenant' && (
                          <div onClick={(e) => e.stopPropagation()} className="flex flex-col items-center gap-1">
                            <ToggleSwitch
                              checked={isPublished}
                              onChange={async () => {
                                try {
                                  const pageService = (await import('@/services/page.service')).default
                                  await pageService.update(parentPage.id, { status: !isPublished ? 'published' : 'draft' })
                                  toast.success(`Page ${!isPublished ? 'publiée' : 'dépubliée'} !`)
                                  loadAvailablePages()
                                } catch (error: any) {
                                  console.error('Error publication page tenant:', error)
                                  toast.error('Error lors de la publication')
                                }
                              }}
                              size="sm"
                              color="green"
                            />
                            <span className="text-xs text-gray-500 dark:text-gray-400">Publié</span>
                          </div>
                        )}
                        
                        {/* Toggle Visible */}
                        <div onClick={(e) => e.stopPropagation()} className="flex flex-col items-center gap-1">
                          <ToggleSwitch
                            checked={parent.is_active !== false}
                            onChange={() => handleToggleActive(parent)}
                            size="sm"
                            color="blue"
                          />
                          <span className="text-xs text-gray-500 dark:text-gray-400">Visible</span>
                        </div>
                        
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            {!isSubPage && (
                              <svg className="w-4 h-4 text-blue-600 dark:text-blue-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
                              </svg>
                            )}
                            <span className="font-medium text-gray-900 dark:text-gray-100 break-words">{parentPage.title}</span>
                            <span className="text-xs text-gray-500 dark:text-gray-400">
                              ({parent.page_type === 'tenant' ? parentPage.slug : parentPage.slug})
                            </span>
                            {parent.page_type === 'tenant' && (
                              <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-200 rounded-full text-xs font-medium">
                                Tenant
                              </span>
                            )}
                            
                            {/* Badge pour indiquer si c'est une page principale avec sous-pages */}
                            {!isSubPage && children.length > 0 && (
                              <span className="px-2 py-0.5 bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 rounded-full text-xs font-medium">
                                {children.length} sous-page{children.length > 1 ? 's' : ''}
                              </span>
                            )}
                            
                            {/* Indicateur autres projets */}
                            {parentPage.otherProjects && parentPage.otherProjects.length > 0 && (
                              <div className="group relative">
                                <div className="flex items-center gap-1 px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 rounded-full text-xs font-medium cursor-help">
                                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                                  </svg>
                                  <span>{parentPage.otherProjects.length} autre{parentPage.otherProjects.length > 1 ? 's' : ''}</span>
                                </div>
                                {/* Tooltip avec liste des projets */}
                                <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block z-10 w-64">
                                  <div className="bg-gray-900 dark:bg-gray-800 text-white text-xs rounded-lg shadow-lg p-3 border border-gray-700">
                                    <div className="font-semibold mb-2">Aussi dans :</div>
                                    <ul className="space-y-1">
                                      {parentPage.otherProjects.map((p: any) => (
                                        <li key={p.id} className="text-gray-300 dark:text-gray-400">
                                          • {p.name} (ID: {p.id})
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                </div>
                              </div>
                            )}
                            
                            {/* Badge Publié */}
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              isPublished
                                ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                            }`}>
                              {isPublished ? 'Publiée' : 'Non publiée'}
                            </span>
                            
                            {/* Badge Visible */}
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              parent.is_active !== false
                                ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                            }`}>
                              {parent.is_active !== false ? 'Visible' : 'Masquée'}
                            </span>
                          </div>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                        {/* Bouton pour créer une sous-page (uniquement pour les pages principales) */}
                        {!isSubPage && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setCreatingSubPage(parentPage.slug)
                              setSubPageName('')
                            }}
                            className="px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                            title="Créer une sous-page"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            <span className="hidden sm:inline">Sous-page</span>
                          </button>
                        )}
                        
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            if (parent.page_type === 'public') {
                              handlePreviewPage(parentPage.slug, 'public')
                            } else if (parent.page_type === 'tenant') {
                              // Use tenant_id:page_id format for consistency
                              const pageReference = project?.tenant_id 
                                ? `${project.tenant_id}:${parentPage.id}` 
                                : parentPage.id.toString()
                              handlePreviewPage(pageReference, 'tenant')
                            }
                          }}
                          className="px-3 py-1.5 bg-purple-600 text-white rounded hover:bg-purple-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                          title="Aperçu de la page"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        </button>
                        
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            if (parent.page_type === 'public') {
                              const landing = huberaLandingUrl(project, parentPage.slug)
                              if (landing) {
                                window.open(landing, '_blank')
                              } else {
                                window.open(`/${parentPage.slug === 'home' ? '' : parentPage.slug}`, '_blank')
                              }
                            } else if (parent.page_type === 'tenant' && project?.tenant_domain) {
                              // Tenant page: use tenant domain
                              const protocol = window.location.protocol
                              const tenantUrl = `${protocol}//${project.tenant_domain}`
                              const pageSlug = parentPage.slug || ''
                              const pagePath = pageSlug === 'accueil' || pageSlug === 'home' ? '' : `/${pageSlug}`
                              window.open(`${tenantUrl}${pagePath}`, '_blank')
                            } else {
                              toast.error('URL du tenant non disponible')
                            }
                          }}
                          className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                          title={parent.page_type === 'tenant' ? 'Voir la page sur le site du tenant' : 'Voir la page en public'}
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                          <span className="hidden sm:inline">Voir</span>
                        </button>
                        
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handlePageClick()
                          }}
                          className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                          title="Éditer"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                          <span className="hidden sm:inline">Éditer</span>
                        </button>
                        
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRemovePage(parent.id)
                          }}
                          className="px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                          title="Retirer cette page du projet (la page existe toujours)"
                        >
                          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          <span className="hidden sm:inline">Retirer</span>
                        </button>
                      </div>
                    </div>
                    
                    {/* Formulaire pour créer une sous-page */}
                    {creatingSubPage === parentPage.slug && !isSubPage && (
                      <div className="ml-6 p-4 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-lg">
                        <div className="flex items-center gap-2 mb-2">
                          <svg className="w-5 h-5 text-indigo-600 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                          </svg>
                          <span className="font-medium text-indigo-900 dark:text-indigo-100">Créer une sous-page de "{parentPage.title}"</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            value={subPageName}
                            onChange={(e) => setSubPageName(e.target.value)}
                            onKeyPress={(e) => {
                              if (e.key === 'Enter') {
                                handleCreateSubPage(parentPage.slug)
                              }
                            }}
                            placeholder="Nom de la sous-page (ex: getting-started)"
                            className="flex-1 px-3 py-2 border border-indigo-300 dark:border-indigo-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            autoFocus
                          />
                          <button
                            onClick={() => handleCreateSubPage(parentPage.slug)}
                            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-medium"
                          >
                            Créer
                          </button>
                          <button
                            onClick={() => {
                              setCreatingSubPage(null)
                              setSubPageName('')
                            }}
                            className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                          >
                            Annuler
                          </button>
                        </div>
                        <p className="text-xs text-indigo-700 dark:text-indigo-300 mt-2">
                          La sous-page sera accessible à : <code className="bg-indigo-100 dark:bg-indigo-900 px-1 rounded">/{parentPage.slug}/[nom]</code>
                        </p>
                      </div>
                    )}
                    
                    {/* Affichage des sous-pages */}
                    {children.length > 0 && expandedPages.has(parent.id) && (
                      <div className="ml-6 space-y-2 border-l-2 border-indigo-200 dark:border-indigo-800 pl-4">
                        {children.map((childPage: ProjectPage) => {
                          // Find child page data based on page_type
                          let childPageData: any = null
                          if (childPage.page_type === 'public') {
                            childPageData = publicPages.find((p: any) => p.slug === childPage.page_slug)
                          } else if (childPage.page_type === 'tenant') {
                            // For tenant pages, page_slug can be:
                            // - Old format: just page ID (e.g., "1")
                            // - New format: tenant_id:page_id (e.g., "5:1")
                            let pageId: number
                            if (childPage.page_slug.includes(':')) {
                              // New format: tenant_id:page_id
                              const [, id] = childPage.page_slug.split(':')
                              pageId = parseInt(id)
                            } else {
                              // Old format: just page ID
                              pageId = parseInt(childPage.page_slug)
                            }
                            childPageData = tenantPages.find((p: any) => p.id === pageId)
                          }
                          
                          if (!childPageData) return null
                          
                          const childIsPublished = childPageData.is_active !== false
                          
                          const handleChildPageClick = () => {
                            if (childPage.page_type === 'public') {
                              navigate(`/admin/pages-public/edit/${childPageData.slug}?projectId=${project.uuid || project.slug}`)
                            } else if (childPage.page_type === 'tenant') {
                              navigate(`/dashboard/pages/${childPageData.id}/edit`)
                            }
                          }
                          
                          return (
                            <div
                              key={childPage.id}
                              onClick={handleChildPageClick}
                              className="flex items-center justify-between p-3 sm:p-4 rounded-lg border bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800 hover:bg-purple-100 dark:hover:bg-purple-900/30 cursor-pointer transition-all group"
                              title="Double-cliquer pour éditer"
                            >
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <div className="flex-shrink-0 text-purple-600 dark:text-purple-400">
                                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                  </svg>
                                </div>
                                
                                {childPage.page_type === 'public' && (
                                  <div onClick={(e) => e.stopPropagation()} className="flex flex-col items-center gap-1">
                                    <ToggleSwitch
                                      checked={childIsPublished}
                                      onChange={() => handleTogglePublished(childPageData.slug, childIsPublished)}
                                      size="sm"
                                      color="green"
                                    />
                                    <span className="text-xs text-gray-500 dark:text-gray-400">Publié</span>
                                  </div>
                                )}
                                {childPage.page_type === 'tenant' && (
                                  <div onClick={(e) => e.stopPropagation()} className="flex flex-col items-center gap-1">
                                    <ToggleSwitch
                                      checked={childIsPublished}
                                      onChange={async () => {
                                        try {
                                          const pageService = (await import('@/services/page.service')).default
                                          await pageService.update(childPageData.id, { status: !childIsPublished ? 'published' : 'draft' })
                                          toast.success(`Page ${!childIsPublished ? 'publiée' : 'dépubliée'} !`)
                                          loadAvailablePages()
                                        } catch (error: any) {
                                          console.error('Error publication page tenant:', error)
                                          toast.error('Error lors de la publication')
                                        }
                                      }}
                                      size="sm"
                                      color="green"
                                    />
                                    <span className="text-xs text-gray-500 dark:text-gray-400">Publié</span>
                                  </div>
                                )}
                                
                                <div onClick={(e) => e.stopPropagation()} className="flex flex-col items-center gap-1">
                                  <ToggleSwitch
                                    checked={childPage.is_active !== false}
                                    onChange={() => handleToggleActive(childPage)}
                                    size="sm"
                                    color="blue"
                                  />
                                  <span className="text-xs text-gray-500 dark:text-gray-400">Visible</span>
                                </div>
                                
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-medium text-gray-900 dark:text-gray-100 break-words">{childPageData.title}</span>
                                    <span className="text-xs text-gray-500 dark:text-gray-400">({childPageData.slug})</span>
                                    
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                      childIsPublished
                                        ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                                    }`}>
                                      {childIsPublished ? 'Publiée' : 'Non publiée'}
                                    </span>
                                    
                                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                      childPage.is_active !== false
                                        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
                                        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                                    }`}>
                                      {childPage.is_active !== false ? 'Visible' : 'Masquée'}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              
                              <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (childPage.page_type === 'public') {
                                      handlePreviewPage(childPageData.slug, 'public')
                                    } else if (childPage.page_type === 'tenant') {
                                      // Use tenant_id:page_id format for consistency
                                      const pageReference = project?.tenant_id 
                                        ? `${project.tenant_id}:${childPageData.id}` 
                                        : childPageData.id.toString()
                                      handlePreviewPage(pageReference, 'tenant')
                                    }
                                  }}
                                  className="px-3 py-1.5 bg-purple-600 text-white rounded hover:bg-purple-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                                  title="Aperçu"
                                >
                                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                  </svg>
                                </button>
                                
                                {childPage.page_type === 'tenant' && project?.tenant_domain && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const protocol = window.location.protocol
                                      const tenantUrl = `${protocol}//${project.tenant_domain}`
                                      const pagePath = childPageData.slug === 'accueil' || childPageData.slug === 'home' ? '' : `/${childPageData.slug}`
                                      window.open(`${tenantUrl}${pagePath}`, '_blank')
                                    }}
                                    className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                                    title="Voir sur le site du tenant"
                                  >
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                    </svg>
                                    <span className="hidden sm:inline">Voir</span>
                                  </button>
                                )}
                                {childPage.page_type === 'public' && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      const landing = huberaLandingUrl(project, childPageData.slug)
                                      window.open(landing || `/${childPageData.slug}`, '_blank')
                                    }}
                                    className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                                    title="Voir en public"
                                  >
                                    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                    </svg>
                                    <span className="hidden sm:inline">Voir</span>
                                  </button>
                                )}
                                
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleChildPageClick()
                                  }}
                                  className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                                  title="Éditer"
                                >
                                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                  </svg>
                                  <span className="hidden sm:inline">Éditer</span>
                                </button>
                                
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleRemovePage(childPage.id)
                                  }}
                                  className="px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                                  title="Retirer"
                                >
                                  <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                  <span className="hidden sm:inline">Retirer</span>
                                </button>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-gray-500 dark:text-gray-400 text-center py-4">
                Aucune page liée à ce projet
              </p>
            )}
          </div>
          
          {/* Section 2: Pages disponibles (non liées) */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-6">
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
                    <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    Pages disponibles
                    {publicPages.filter((p: any) => {
                      const isNotLinked = !project.pages?.find((pp: ProjectPage) => pp.page_slug === p.slug && pp.page_type === 'public')
                      const matchesSearch = !searchQuery || 
                        p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                        p.slug.toLowerCase().includes(searchQuery.toLowerCase())
                      return isNotLinked && matchesSearch
                    }).length > 0 && (
                      <span className="ml-2 px-2 py-1 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded-full text-sm font-medium">
                        {publicPages.filter((p: any) => {
                          const isNotLinked = !project.pages?.find((pp: ProjectPage) => pp.page_slug === p.slug && pp.page_type === 'public')
                          const matchesSearch = !searchQuery || 
                            p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            p.slug.toLowerCase().includes(searchQuery.toLowerCase())
                          return isNotLinked && matchesSearch
                        }).length}
                      </span>
                    )}
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    Pages créées dans le système mais non encore liées à ce projet
                  </p>
                </div>
              </div>
              
              {/* Barre de recherche */}
              <div className="mt-4">
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg className="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                  </div>
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Rechercher une page (titre ou slug)..."
                    className="block w-full pl-10 pr-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute inset-y-0 right-0 pr-3 flex items-center"
                    >
                      <svg className="h-5 w-5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            </div>
            
            {/* Liste des pages disponibles */}
            {publicPages.filter((p: any) => {
              const isNotLinked = !project.pages?.find((pp: ProjectPage) => pp.page_slug === p.slug && pp.page_type === 'public')
              const matchesSearch = !searchQuery || 
                p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                p.slug.toLowerCase().includes(searchQuery.toLowerCase())
              return isNotLinked && matchesSearch
            }).length > 0 ? (
              <div className="space-y-2">
                {publicPages
                  .filter((p: any) => {
                    const isNotLinked = !project.pages?.find((pp: ProjectPage) => pp.page_slug === p.slug && pp.page_type === 'public')
                    const matchesSearch = !searchQuery || 
                      p.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
                      p.slug.toLowerCase().includes(searchQuery.toLowerCase())
                    return isNotLinked && matchesSearch
                  })
                  .map((page: any) => {
                    const isPublished = page.is_active !== false
                    
                    // Fonction pour naviguer vers l'édition de la page
                    const handlePageClick = () => {
                      if (page.slug === 'home') {
                        navigate(`/admin/pages-public/edit/home?projectId=${project.uuid || project.slug}`)
                      } else {
                        navigate(`/admin/pages-public/edit/${page.slug}?projectId=${project.uuid || project.slug}`)
                      }
                    }
                    
                    return (
                      <div
                        key={page.slug}
                        onClick={handlePageClick}
                        className="flex items-center justify-between p-3 sm:p-4 rounded-lg border bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer transition-all group"
                        title="Double-cliquer pour éditer"
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          {/* Toggle Publié */}
                          <div onClick={(e) => e.stopPropagation()} className="flex flex-col items-center gap-1">
                            <ToggleSwitch
                              checked={isPublished}
                              onChange={() => handleTogglePublished(page.slug, isPublished)}
                              size="sm"
                              color="green"
                            />
                            <span className="text-xs text-gray-500 dark:text-gray-400">Publié</span>
                          </div>
                          
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-gray-900 dark:text-gray-100 break-words">{page.title}</span>
                              <span className="text-xs text-gray-500 dark:text-gray-400">({page.slug})</span>
                              
                              {/* Indicateur autres projets */}
                              {page.otherProjects && page.otherProjects.length > 0 && (
                                <div className="group relative">
                                  <div className="flex items-center gap-1 px-2 py-0.5 bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 rounded-full text-xs font-medium cursor-help">
                                    <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                      <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                                    </svg>
                                    <span>{page.otherProjects.length} autre{page.otherProjects.length > 1 ? 's' : ''}</span>
                                  </div>
                                  {/* Tooltip avec liste des projets */}
                                  <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block z-10 w-64">
                                    <div className="bg-gray-900 dark:bg-gray-800 text-white text-xs rounded-lg shadow-lg p-3 border border-gray-700">
                                      <div className="font-semibold mb-2">Aussi dans :</div>
                                      <ul className="space-y-1">
                                        {page.otherProjects.map((p: any) => (
                                          <li key={p.id} className="text-gray-300 dark:text-gray-400">
                                            • {p.name} (ID: {p.id})
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  </div>
                                </div>
                              )}
                              
                              {/* Badge Publié */}
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                                isPublished
                                  ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                                  : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                              }`}>
                                {isPublished ? 'Publiée' : 'Non publiée'}
                              </span>
                            </div>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              const pageProjectPage = project?.pages?.find((p: ProjectPage) => p.page_slug === page.slug && p.page_type === 'public')
                              if (pageProjectPage) {
                                handlePreviewPage(page.slug, 'public')
                              } else {
                                // Try tenant page
                                const tenantPageProjectPage = project?.pages?.find((p: ProjectPage) => {
                                  const pageId = parseInt(p.page_slug)
                                  return p.page_type === 'tenant' && tenantPages.find(tp => tp.id === pageId)?.slug === page.slug
                                })
                                if (tenantPageProjectPage) {
                                  const tenantPage = tenantPages.find(tp => tp.id === parseInt(tenantPageProjectPage.page_slug))
                                  if (tenantPage) {
                                    handlePreviewPage(tenantPage.id.toString(), 'tenant')
                                  }
                                }
                              }
                            }}
                            className="px-3 py-1.5 bg-purple-600 text-white rounded hover:bg-purple-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                            title="Aperçu de la page"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                            </svg>
                          </button>
                          
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              const pageProjectPage = project?.pages?.find((p: ProjectPage) => p.page_slug === page.slug && p.page_type === 'public')
                              if (pageProjectPage) {
                                const landing = huberaLandingUrl(project, page.slug)
                                if (landing) {
                                  window.open(landing, '_blank')
                                } else {
                                  window.open(`/${page.slug === 'home' ? '' : page.slug}`, '_blank')
                                }
                              } else {
                                // Try tenant page
                                const tenantPageProjectPage = project?.pages?.find((p: ProjectPage) => {
                                  const pageId = parseInt(p.page_slug)
                                  return p.page_type === 'tenant' && tenantPages.find(tp => tp.id === pageId)?.slug === page.slug
                                })
                                if (tenantPageProjectPage && project?.tenant_domain) {
                                  const tenantPage = tenantPages.find(tp => tp.id === parseInt(tenantPageProjectPage.page_slug))
                                  if (tenantPage) {
                                    const protocol = window.location.protocol
                                    const tenantUrl = `${protocol}//${project.tenant_domain}`
                                    const pagePath = tenantPage.slug === 'accueil' || tenantPage.slug === 'home' ? '' : `/${tenantPage.slug}`
                                    window.open(`${tenantUrl}${pagePath}`, '_blank')
                                  }
                                } else {
                                  toast.error('URL du tenant non disponible')
                                }
                              }
                            }}
                            className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                            title="Voir la page"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                            </svg>
                            <span className="hidden sm:inline">Voir</span>
                          </button>
                          
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handlePageClick()
                            }}
                            className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                            title="Éditer"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                            <span className="hidden sm:inline">Éditer</span>
                          </button>
                          
                          {/* Bouton Dupliquer (si la page est dans un autre projet) */}
                          {page.otherProjects && page.otherProjects.length > 0 && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDuplicatePage(page.slug)
                              }}
                              className="px-3 py-1.5 bg-purple-600 text-white rounded hover:bg-purple-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                              title="Dupliquer cette page pour ce projet"
                            >
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                              <span className="hidden sm:inline">Dupliquer</span>
                            </button>
                          )}
                          
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleAddPage(page.slug, 'public')
                            }}
                            className="px-3 py-1.5 bg-green-600 text-white rounded hover:bg-green-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                            title="Ajouter cette page au projet"
                          >
                            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                            <span className="hidden sm:inline">Ajouter au projet</span>
                            <span className="sm:hidden">Ajouter</span>
                          </button>
                          
                          {/* Bouton Supprimer (uniquement pour admin) */}
                          {authService.isSuperAdmin() && page.slug !== 'home' && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDeletePage(page.slug)
                              }}
                              className="px-3 py-1.5 bg-red-600 text-white rounded hover:bg-red-700 text-sm font-medium transition-colors flex items-center gap-1.5"
                              title="Supprimer définitivement cette page"
                            >
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                              <span className="hidden sm:inline">Supprimer</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )
                  })}
              </div>
            ) : searchQuery ? (
              <p className="text-gray-500 dark:text-gray-400 text-center py-4">
                Aucune page disponible ne correspond à votre recherche "{searchQuery}"
              </p>
            ) : (
              <p className="text-gray-500 dark:text-gray-400 text-center py-4">
                Toutes les pages sont déjà liées à ce projet
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Preview Modal */}
      {previewPage && (
        <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-6xl w-full max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center flex-shrink-0">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Prévisualisation : {previewPage.title}
              </h2>
              <button
                onClick={() => setPreviewPage(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 bg-gray-50 dark:bg-gray-900">
              {loadingPreview ? (
                <div className="flex items-center justify-center h-full">
                  <div className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                    <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    <span>Chargement de la prévisualisation...</span>
                  </div>
                </div>
              ) : previewPage.blocks && previewPage.blocks.length > 0 ? (
                <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm overflow-hidden">
                  {/* Remove padding to allow full-width blocks like hero */}
                  <BlockPreview 
                    blocks={previewPage.blocks} 
                    blockTypes={blockTypes} 
                    isInteractive={false}
                    isEditable={false}
                  />
                </div>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <div className="text-center">
                    <svg className="h-12 w-12 mx-auto text-gray-300 dark:text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    <p className="text-gray-500 dark:text-gray-400 font-medium">Cette page ne contient pas encore de blocs</p>
                    <p className="text-sm text-gray-400 dark:text-gray-500 mt-1">Ajoutez des blocs en éditant la page</p>
                  </div>
                </div>
              )}
            </div>
            <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-3 flex-shrink-0">
              <button
                onClick={() => {
                  if (previewPage) {
                    const page = project?.pages?.find((p: ProjectPage) => p.page_slug === previewPage.slug)
                    if (page && page.page_type === 'public') {
                      navigate(`/admin/pages-public/edit/${previewPage.slug}?projectId=${project.uuid || project.slug}`)
                    }
                  }
                }}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                Éditer la page
              </button>
              <button
                onClick={() => setPreviewPage(null)}
                className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </AdminLayout>
  )
}

