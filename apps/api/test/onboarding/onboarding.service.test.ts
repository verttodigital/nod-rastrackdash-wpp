import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "../../src/auth/session.types";
import type { IntegrationsService } from "../../src/integrations/integrations.service";
import type { LicenseClientService } from "../../src/licensing-client/license-client.service";
import type { LicenseRuntimeState } from "../../src/licensing-client/license-client.types";
import { OnboardingService } from "../../src/onboarding/onboarding.service";
import type { PrismaService } from "../../src/common/prisma/prisma.service";
import type { WorkspacesService } from "../../src/workspaces/workspaces.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";

function authenticatedUser(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    user: {
      id: "user-1",
      email: "student@example.com",
      name: "Student",
      authProvider: "email",
      emailVerifiedAt: new Date(),
    },
    activeWorkspaceId: "workspace-1",
    workspaces: [
      {
        id: "workspace-1",
        name: "Minha Agencia",
        slug: "minha-agencia",
        role: "owner",
        operationalStatus: "active",
      },
    ],
    ...overrides,
  };
}

function licenseState(overrides: Partial<LicenseRuntimeState> = {}): LicenseRuntimeState {
  return {
    status: "active",
    softLock: false,
    hardLock: false,
    usable: true,
    expiresAt: null,
    validUntil: null,
    source: "cache",
    reason: null,
    interval: null,
    ...overrides,
  };
}

function fakePrisma(overrides: {
  queryRaw?: () => Promise<unknown>;
  manualConnection?: () => Promise<{ id: string } | null>;
} = {}): PrismaService {
  return {
    $queryRaw: overrides.queryRaw ?? vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    metaBusinessConnection: {
      findFirst: vi.fn(overrides.manualConnection ?? (() => Promise.resolve(null))),
    },
  } as unknown as PrismaService;
}

function fakeLicenseClient(overrides: { getState?: () => Promise<LicenseRuntimeState> } = {}): LicenseClientService {
  return {
    getState: overrides.getState ? vi.fn(overrides.getState) : vi.fn().mockResolvedValue(licenseState()),
  } as unknown as LicenseClientService;
}

function fakeIntegrations(status: "connected" | "not_connected" | "error" = "connected"): IntegrationsService {
  return {
    getMetaConnection: vi.fn().mockResolvedValue({
      workspaceId: "workspace-1",
      status,
      tokenType: null,
      scopes: [],
      expiresAt: null,
      connectedAt: null,
      selectedBusinessId: null,
      selectedAdAccountId: null,
      selectedPixelId: null,
      capiTokenConfigured: false,
    }),
  } as unknown as IntegrationsService;
}

function fakeWorkspaces(): WorkspacesService {
  return {
    getCurrentWorkspace: vi.fn().mockReturnValue({
      id: "workspace-1",
      name: "Minha Agencia",
      slug: "minha-agencia",
      role: "owner",
      operationalStatus: "active",
      permissions: {},
      accessMode: "member",
      platformRole: null,
    }),
  } as unknown as WorkspacesService;
}

describe("OnboardingService", () => {
  it.each(["platform_owner", "platform_operator"] as const)(
    "checks the selected support workspace for %s without creating a membership",
    async (platformRole) => {
      const user = authenticatedUser({ workspaces: [], activeWorkspaceId: null });
      user.user.platformRole = platformRole;
      user.supportContext = {
        workspaceId: "supported-workspace",
        workspaceName: "Client",
        workspaceSlug: "client",
        startedAt: new Date().toISOString(),
      };
      const context = new WorkspaceContextService();
      const workspaces = {
        getCurrentWorkspace: (session: AuthenticatedUser) => context.getCurrentWorkspace(session),
      } as WorkspacesService;
      const integrations = fakeIntegrations();
      const service = new OnboardingService(fakePrisma(), fakeLicenseClient(), integrations, workspaces);

      const status = await service.getStatus(user);

      expect(status.completedCount).toBe(4);
      expect(integrations.getMetaConnection).toHaveBeenCalledWith("supported-workspace");
      expect(user.workspaces).toEqual([]);
    },
  );

  it("does not treat an ordinary user's support-shaped data as workspace access", async () => {
    const user = authenticatedUser({ workspaces: [], activeWorkspaceId: null });
    user.supportContext = {
      workspaceId: "other-workspace", workspaceName: "Other", workspaceSlug: "other",
      startedAt: new Date().toISOString(),
    };
    const integrations = fakeIntegrations();
    const service = new OnboardingService(fakePrisma(), fakeLicenseClient(), integrations, fakeWorkspaces());
    const status = await service.getStatus(user);
    expect(status.completedCount).toBe(2);
    expect(integrations.getMetaConnection).not.toHaveBeenCalled();
  });

  it("recognizes an active manual connection without a legacy MetaIntegration row", async () => {
    const prisma = fakePrisma({ manualConnection: async () => ({ id: "manual-business" }) });
    const service = new OnboardingService(prisma, fakeLicenseClient(), fakeIntegrations("not_connected"), fakeWorkspaces());
    const before = new Date();
    const status = await service.getStatus(authenticatedUser());
    const after = new Date();
    expect(status.checks.metaConnected).toBe(true);
    expect(status.completedCount).toBe(4);
    const query = vi.mocked(prisma.metaBusinessConnection.findFirst).mock.calls[0]?.[0];
    expect(query).toMatchObject({
      where: {
        workspaceId: "workspace-1", status: "active",
        credential: {
          workspaceId: "workspace-1", source: "manual", status: "active",
          OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
        },
      },
      select: { id: true },
    });
    const expiresAfter = (query?.where?.credential as { OR: [{ expiresAt: null }, { expiresAt: { gt: Date } }] }).OR[1].expiresAt.gt;
    expect(expiresAfter.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(expiresAfter.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("keeps a valid manual connection visible if the legacy lookup fails", async () => {
    const integrations = fakeIntegrations();
    vi.mocked(integrations.getMetaConnection).mockRejectedValue(new Error("legacy unavailable"));
    const service = new OnboardingService(
      fakePrisma({ manualConnection: async () => ({ id: "manual-business" }) }),
      fakeLicenseClient(), integrations, fakeWorkspaces(),
    );
    expect((await service.getStatus(authenticatedUser())).checks.metaConnected).toBe(true);
  });

  it("preserves the legacy connection if the manual lookup fails", async () => {
    const service = new OnboardingService(
      fakePrisma({ manualConnection: async () => { throw new Error("manual unavailable"); } }),
      fakeLicenseClient(), fakeIntegrations(), fakeWorkspaces(),
    );
    expect((await service.getStatus(authenticatedUser())).checks.metaConnected).toBe(true);
  });

  it("reports every check as true when everything is healthy", async () => {
    const service = new OnboardingService(
      fakePrisma(),
      fakeLicenseClient(),
      fakeIntegrations("connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser());

    expect(status).toEqual({
      checks: {
        database: true,
        licenseActive: true,
        metaConnected: true,
        hasWorkspace: true,
      },
      completedCount: 4,
      totalCount: 4,
    });
  });

  it("marks database as false when the query fails", async () => {
    const service = new OnboardingService(
      fakePrisma({ queryRaw: () => Promise.reject(new Error("connection refused")) }),
      fakeLicenseClient(),
      fakeIntegrations("connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.database).toBe(false);
    expect(status.completedCount).toBe(3);
  });

  it("marks licenseActive as false for a grace-window-exceeded/blocked license", async () => {
    const service = new OnboardingService(
      fakePrisma(),
      fakeLicenseClient({ getState: () => Promise.resolve(licenseState({ status: "blocked", usable: false })) }),
      fakeIntegrations("connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.licenseActive).toBe(false);
  });

  it("treats the license as active during the grace window", async () => {
    const service = new OnboardingService(
      fakePrisma(),
      fakeLicenseClient({ getState: () => Promise.resolve(licenseState({ status: "grace", usable: true })) }),
      fakeIntegrations("connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.licenseActive).toBe(true);
  });

  it("marks metaConnected as false when Meta is not connected", async () => {
    const service = new OnboardingService(
      fakePrisma(),
      fakeLicenseClient(),
      fakeIntegrations("not_connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.metaConnected).toBe(false);
  });

  it("marks hasWorkspace and metaConnected as false when the user has no workspaces", async () => {
    const service = new OnboardingService(
      fakePrisma(),
      fakeLicenseClient(),
      fakeIntegrations("connected"),
      fakeWorkspaces(),
    );

    const status = await service.getStatus(authenticatedUser({ workspaces: [], activeWorkspaceId: null }));

    expect(status.checks.hasWorkspace).toBe(false);
    expect(status.checks.metaConnected).toBe(false);
    expect(status.completedCount).toBe(2);
  });

  it("fails the meta check open (false) instead of throwing when the integrations service errors", async () => {
    const integrations = {
      getMetaConnection: vi.fn().mockRejectedValue(new Error("meta api down")),
    } as unknown as IntegrationsService;
    const service = new OnboardingService(fakePrisma(), fakeLicenseClient(), integrations, fakeWorkspaces());

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.metaConnected).toBe(false);
  });

  it("degrades gracefully to metaConnected=false when integrations/workspaces are not wired (public/minimal setups)", async () => {
    const service = new OnboardingService(fakePrisma(), fakeLicenseClient());

    const status = await service.getStatus(authenticatedUser());

    expect(status.checks.metaConnected).toBe(false);
    expect(status.checks.hasWorkspace).toBe(true);
  });
});
