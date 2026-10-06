import { Controller, Get, Inject } from "@nestjs/common";
import { AuthToken } from "../auth/auth-user.decorator";
import { AuthService } from "../auth/auth.service";
import { OnboardingService } from "./onboarding.service";
import type { OnboardingStatusDto } from "./onboarding.types";

/**
 * Auth-required onboarding checklist (F6.3) — reuses the existing session
 * so `hasWorkspace`/`metaConnected` reflect the caller's real workspace
 * membership or platform support context. Soft signal only: no write actions.
 */
@Controller("onboarding")
export class OnboardingController {
  constructor(
    @Inject(AuthService) private readonly authService: AuthService,
    @Inject(OnboardingService) private readonly onboardingService: OnboardingService,
  ) {}

  @Get("status")
  async getStatus(@AuthToken() refreshToken: string): Promise<OnboardingStatusDto> {
    const authenticated = await this.authService.getSession(refreshToken);
    return this.onboardingService.getStatus(authenticated);
  }
}
