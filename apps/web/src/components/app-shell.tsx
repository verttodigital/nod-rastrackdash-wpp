"use client";

import { clientNavigation, clientNavVisibleForPermissions } from "@wpptrack/shared";
import type {
  CurrentWorkspaceDto,
  WhatsappDataSourceDto,
  WorkspaceListEntryDto,
} from "@wpptrack/shared";
import {
  BarChart3,
  Building2,
  Check,
  ChevronsUpDown,
  LayoutDashboard,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Send,
  Settings2,
  ShieldCheck,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useRef, useState, useTransition } from "react";
import { LogoutButton } from "./logout-button";
import { BrandFooter } from "./brand-footer";
import { DataAutoRefresh } from "./data-auto-refresh";
import { PresentationMask } from "./presentation-mask";
import {
  PresentationModeToggle,
  usePresentationMode,
} from "./presentation-mode-toggle";
import { exitPlatformSupportAccess } from "../app/actions/platform-support";
import { switchActiveWorkspace } from "../app/actions/workspaces";
import { defaultBrandConfig, type BrandConfig } from "../lib/brand";

const sidebarStorageKey = "wpptrack-sidebar-collapsed";

type ClientNavigationId = (typeof clientNavigation)[number]["id"];

const navigationIconById: Record<ClientNavigationId, LucideIcon> = {
  overview: LayoutDashboard,
  leads: UsersRound,
  reports: BarChart3,
  events: Send,
  integrations: Plug,
  settings: Settings2,
};

const navigationGroupDefinitions = [
  {
    label: "Operacao",
    ids: ["overview", "leads", "reports", "events"],
  },
  {
    label: "Gestao",
    ids: ["integrations", "settings"],
  },
] as const;

function visibleNavigationGroups(
  permissions: CurrentWorkspaceDto["permissions"] | null | undefined,
) {
  return navigationGroupDefinitions
    .map((group) => ({
      label: group.label,
      items: clientNavigation.filter(
        (item) =>
          (group.ids as readonly ClientNavigationId[]).includes(item.id) &&
          clientNavVisibleForPermissions(item.id, permissions),
      ),
    }))
    .filter((group) => group.items.length > 0);
}

function workspaceAccessLabel(workspace: CurrentWorkspaceDto): string {
  if (workspace.accessMode === "platform_support") {
    return "acesso de suporte";
  }

  return workspaceRoleLabel(workspace.role).toLowerCase();
}

function workspaceRoleLabel(role: WorkspaceListEntryDto["role"]): string {
  if (role === "owner") {
    return "responsavel da conta";
  }

  return role === "admin" ? "administrador" : "analista";
}

function BrandMark({ brand }: { brand: BrandConfig }) {
  if (brand.logoUrl) {
    // eslint-disable-next-line @next/next/no-img-element -- arbitrary
    // student-provided logo URL, outside next/image's static domain config.
    return <img className="brand-mark brand-mark-logo" src={brand.logoUrl} alt="" />;
  }

  return (
    <span className="brand-mark">{brand.name.trim().charAt(0).toUpperCase() || "R"}</span>
  );
}

export function AppShell({
  children,
  dataSource,
  workspace,
  workspaces = [],
  brand = defaultBrandConfig,
}: {
  children: ReactNode;
  dataSource?: WhatsappDataSourceDto | null;
  workspace?: CurrentWorkspaceDto | null;
  workspaces?: WorkspaceListEntryDto[];
  brand?: BrandConfig;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const presentationMode = usePresentationMode();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceSwitchError, setWorkspaceSwitchError] = useState(false);
  const [isWorkspaceSwitchPending, startWorkspaceTransition] = useTransition();
  const workspaceSelectorRef = useRef<HTMLElement>(null);
  const previousAccessPathnameRef = useRef(pathname);

  useEffect(() => {
    if (previousAccessPathnameRef.current === pathname) {
      return;
    }

    previousAccessPathnameRef.current = pathname;
    router.refresh();
  }, [pathname, router]);

  useEffect(() => {
    setSidebarCollapsed(
      window.localStorage.getItem(sidebarStorageKey) === "true",
    );
  }, []);

  useEffect(() => {
    window.localStorage.setItem(sidebarStorageKey, String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 900px)");
    const updateViewport = () => {
      setIsMobile(mediaQuery.matches);

      if (!mediaQuery.matches) {
        setMobileMenuOpen(false);
      }
    };

    updateViewport();
    mediaQuery.addEventListener("change", updateViewport);

    return () => mediaQuery.removeEventListener("change", updateViewport);
  }, []);

  useEffect(() => {
    if (!isMobile || !mobileMenuOpen) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMobileMenuOpen(false);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [isMobile, mobileMenuOpen]);

  useEffect(() => {
    if (!workspaceMenuOpen) {
      return;
    }

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!workspaceSelectorRef.current?.contains(event.target as Node)) {
        setWorkspaceMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkspaceMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [workspaceMenuOpen]);

  const closeMobileMenu = () => setMobileMenuOpen(false);
  const navigationGroups = visibleNavigationGroups(workspace?.permissions);
  const canSelectWorkspace =
    workspace?.accessMode !== "platform_support" &&
    workspaces.length > 0 &&
    (workspaces.length > 1 || !workspace);

  const openWorkspaceMenu = () => {
    setWorkspaceSwitchError(false);

    if (sidebarCollapsed && !isMobile) {
      setSidebarCollapsed(false);
    }

    setWorkspaceMenuOpen((current) => !current);
  };

  const selectWorkspace = (workspaceId: string) => {
    if (workspaceId === workspace?.id || isWorkspaceSwitchPending) {
      setWorkspaceMenuOpen(false);
      return;
    }

    setWorkspaceSwitchError(false);
    startWorkspaceTransition(async () => {
      const result = await switchActiveWorkspace(workspaceId);

      if (!result.ok) {
        setWorkspaceSwitchError(true);
        return;
      }

      setWorkspaceMenuOpen(false);
      closeMobileMenu();
      router.refresh();
    });
  };

  return (
    <div
      className={`app-shell${sidebarCollapsed && !isMobile ? " sidebar-collapsed" : ""}${mobileMenuOpen ? " mobile-menu-open" : ""}`}
      data-sidebar-state={sidebarCollapsed && !isMobile ? "collapsed" : "expanded"}
    >
      <header className="mobile-shell-header">
        <Link
          className="brand"
          href="/overview"
          aria-label={`${brand.name} - ir para a Visao geral`}
          onClick={closeMobileMenu}
        >
          <BrandMark brand={brand} />
          <span className="brand-copy">
            <strong>{brand.name}</strong>
          </span>
        </Link>
        <button
          className="mobile-menu-toggle"
          type="button"
          aria-label={mobileMenuOpen ? "Fechar menu" : "Abrir menu"}
          aria-controls="app-sidebar"
          aria-expanded={mobileMenuOpen}
          onClick={() => setMobileMenuOpen((current) => !current)}
        >
          {mobileMenuOpen ? (
            <X aria-hidden="true" size={20} strokeWidth={2.2} />
          ) : (
            <Menu aria-hidden="true" size={20} strokeWidth={2.2} />
          )}
        </button>
      </header>

      <aside
        id="app-sidebar"
        className="sidebar"
        aria-hidden={isMobile && !mobileMenuOpen}
        inert={isMobile && !mobileMenuOpen}
      >
        <div className="sidebar-topline">
          <Link
            className="brand"
            href="/overview"
            aria-label={`${brand.name} - ir para a Visao geral`}
            onClick={closeMobileMenu}
          >
            <BrandMark brand={brand} />
            <span className="brand-copy">
              <strong>{brand.name}</strong>
            </span>
          </Link>
          <button
            className="sidebar-toggle desktop-sidebar-toggle"
            type="button"
            aria-label={sidebarCollapsed ? "Expandir menu" : "Recolher menu"}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed((current) => !current)}
            title={sidebarCollapsed ? "Expandir menu" : "Recolher menu"}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen aria-hidden="true" size={18} strokeWidth={2.2} />
            ) : (
              <PanelLeftClose aria-hidden="true" size={18} strokeWidth={2.2} />
            )}
            <span className="sidebar-toggle-label">
              {sidebarCollapsed ? "Expandir menu" : "Recolher menu"}
            </span>
          </button>
          <button
            className="sidebar-toggle mobile-sidebar-close"
            type="button"
            aria-label="Fechar menu"
            onClick={closeMobileMenu}
          >
            <X aria-hidden="true" size={20} strokeWidth={2.2} />
          </button>
        </div>

        <section
          ref={workspaceSelectorRef}
          className={`workspace-strip${canSelectWorkspace ? " workspace-selector" : ""}`}
          aria-label="Workspace atual"
        >
          {canSelectWorkspace ? (
            <>
              <button
                className="workspace-selector-trigger"
                type="button"
                aria-label={
                  presentationMode
                    ? "Selecionar workspace demonstrativo"
                    : `Selecionar empresa. Atual: ${workspace?.name ?? "nenhuma"}`
                }
                aria-controls="workspace-selector-menu"
                aria-expanded={workspaceMenuOpen}
                onClick={openWorkspaceMenu}
                title="Selecionar empresa"
              >
                <span className="workspace-selector-icon" aria-hidden="true">
                  <Building2 size={18} strokeWidth={2.1} />
                </span>
                <span className="workspace-selector-copy">
                  <span>Workspace</span>
                  <strong>
                    <PresentationMask placeholder="Workspace demonstrativo">
                      {workspace?.name ?? "Selecionar empresa"}
                    </PresentationMask>
                  </strong>
                  <small>
                    <PresentationMask placeholder="acesso demonstrativo">
                      {workspace
                        ? `${workspace.slug} - ${workspaceAccessLabel(workspace)}`
                        : `${workspaces.length} ${workspaces.length === 1 ? "empresa disponivel" : "empresas disponiveis"}`}
                    </PresentationMask>
                  </small>
                </span>
                <ChevronsUpDown
                  className="workspace-selector-chevron"
                  aria-hidden="true"
                  size={17}
                  strokeWidth={2.1}
                />
              </button>
              <div
                id="workspace-selector-menu"
                className="workspace-selector-menu"
                role="menu"
                aria-label="Empresas autorizadas"
                hidden={!workspaceMenuOpen}
              >
                {workspaces.map((availableWorkspace, index) => {
                  const selected = availableWorkspace.id === workspace?.id;

                  return (
                    <button
                      key={availableWorkspace.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      disabled={selected || isWorkspaceSwitchPending}
                      onClick={() => selectWorkspace(availableWorkspace.id)}
                    >
                      <span>
                        <strong>
                          <PresentationMask
                            placeholder={`Workspace ${index + 1}`}
                          >
                            {availableWorkspace.name}
                          </PresentationMask>
                        </strong>
                        <small>
                          {workspaceRoleLabel(availableWorkspace.role)}
                        </small>
                      </span>
                      {selected ? (
                        <Check aria-hidden="true" size={17} strokeWidth={2.2} />
                      ) : null}
                    </button>
                  );
                })}
                {workspaceSwitchError ? (
                  <p className="workspace-selector-error" role="alert">
                    Nao foi possivel abrir esta empresa.
                  </p>
                ) : null}
              </div>
            </>
          ) : (
            <>
              <span>Workspace</span>
              <strong>
                <PresentationMask placeholder="Workspace demonstrativo">
                  {workspace?.name ?? "Workspace indisponivel"}
                </PresentationMask>
              </strong>
              <small>
                <PresentationMask placeholder="acesso demonstrativo">
                  {workspace
                    ? `${workspace.slug} - ${workspaceAccessLabel(workspace)}`
                    : "Sessao autenticada"}
                </PresentationMask>
              </small>
            </>
          )}
        </section>

        <div className="sidebar-navigation">
          {navigationGroups.map((group) => (
            <nav
              className="sidebar-nav"
              aria-label={group.label}
              key={group.label}
            >
              <p className="nav-label">{group.label}</p>
              {group.items.map((item) => {
                const href = `/${item.id}`;
                const active =
                  pathname === href || pathname.startsWith(`${href}/`);
                const Icon = navigationIconById[item.id];

                return (
                  <Link
                    className={active ? "active" : undefined}
                    key={item.id}
                    href={href}
                    aria-current={active ? "page" : undefined}
                    title={item.label}
                    onClick={closeMobileMenu}
                  >
                    <span className="nav-icon" aria-hidden="true">
                      <Icon size={17} strokeWidth={2.1} />
                    </span>
                    <span className="nav-text">{item.label}</span>
                  </Link>
                );
              })}
            </nav>
          ))}
        </div>

        {workspace?.platformRole ? (
          <nav
            className="sidebar-nav platform-sidebar-nav"
            aria-label="Administracao da plataforma"
          >
            <p className="nav-label">Plataforma</p>
            <Link
              className={
                pathname.startsWith("/backoffice") ? "active" : undefined
              }
              href="/backoffice/clients"
              aria-current={
                pathname.startsWith("/backoffice") ? "page" : undefined
              }
              title="Backoffice"
              onClick={closeMobileMenu}
            >
              <span className="nav-icon" aria-hidden="true">
                <ShieldCheck size={17} strokeWidth={2.1} />
              </span>
              <span className="nav-text">Backoffice</span>
            </Link>
          </nav>
        ) : null}

        <section className="health-panel" aria-label="Conta">
          <p className="nav-label">Conta</p>
          {workspace ? (
            <span
              className={`status-chip${workspace.operationalStatus === "blocked" ? " warn" : ""}`}
            >
              {workspace.operationalStatus === "blocked"
                ? "bloqueado"
                : "ativo"}
            </span>
          ) : null}
          <PresentationModeToggle />
          <LogoutButton />
        </section>
        <BrandFooter brand={brand} />
      </aside>
      <button
        className="mobile-sidebar-backdrop"
        type="button"
        aria-label="Fechar menu"
        tabIndex={mobileMenuOpen ? 0 : -1}
        onClick={closeMobileMenu}
      />
      <main className="content">
        {workspace?.accessMode === "platform_support" ? (
          <div className="support-context-bar" role="status">
            <div>
              <span>Acesso de suporte</span>
              <strong>
                <PresentationMask placeholder="Workspace demonstrativo">
                  {workspace.name}
                </PresentationMask>
              </strong>
            </div>
            <form action={exitPlatformSupportAccess}>
              <button className="button ghost" type="submit">
                Encerrar acesso
              </button>
            </form>
          </div>
        ) : null}
        {workspace ? <DataAutoRefresh source={dataSource ?? null} /> : null}
        {children}
      </main>
    </div>
  );
}
