/**
 * Auth-required onboarding checklist (F6.3). Every flag is a real signal —
 * no hardcoded "true" placeholders — so a first-time student (or an AI
 * agent driving the setup) can tell what is actually left to do.
 */
export type OnboardingChecks = {
  /** `SELECT 1` against Postgres succeeded. */
  database: boolean;
  /** License client state is "active" or "grace" (see LicenseClientService.getState). */
  licenseActive: boolean;
  /** Best-effort: the current workspace has a connected Meta account. */
  metaConnected: boolean;
  /** The user has a membership or an authenticated platform support workspace. */
  hasWorkspace: boolean;
};

export type OnboardingStatusDto = {
  checks: OnboardingChecks;
  completedCount: number;
  totalCount: number;
};
