import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AuthModule } from "./auth/auth.module";
import { BackofficeWhatsappWebhooksModule } from "./backoffice-whatsapp-webhooks/backoffice-whatsapp-webhooks.module";
import { PrismaModule } from "./common/prisma/prisma.module";
import { RequestDurationInterceptor } from "./common/http/request-duration.interceptor";
import { QueueModule } from "./common/queue/queue.module";
import { RuntimeModule } from "./common/runtime/runtime.module";
import { ConversionRulesModule } from "./conversion-rules/conversion-rules.module";
import { DiagnosticsModule } from "./diagnostics/diagnostics.module";
import { EmailModule } from "./email/email.module";
import { ExternalDataModule } from "./external-data/external-data.module";
import { HealthController } from "./health/health.controller";
import { HealthService } from "./health/health.service";
import { InboundWebhooksModule } from "./inbound-webhooks/inbound-webhooks.module";
import { InboundWebhookProductionModule } from "./inbound-webhook-production/inbound-webhook-production.module";
import { InboundWebhookReplayModule } from "./inbound-webhook-replay/inbound-webhook-replay.module";
import { IntegrationsModule } from "./integrations/integrations.module";
import { LeadsModule } from "./leads/leads.module";
import { LicenseClientModule } from "./licensing-client/license-client.module";
import { OnboardingModule } from "./onboarding/onboarding.module";
import { ReportingModule } from "./reporting/reporting.module";
import { ReportSyncModule } from "./report-sync/report-sync.module";
import { TemplateVersionModule } from "./template-version/template-version.module";
import { WebhooksModule } from "./webhooks/webhooks.module";
import { WorkspacesModule } from "./workspaces/workspaces.module";
import { OpsAlertsModule } from "./ops-alerts/ops-alerts.module";

@Module({
  imports: [
    RuntimeModule,
    QueueModule,
    EmailModule,
    PrismaModule,
    AuthModule,
    BackofficeWhatsappWebhooksModule,
    WorkspacesModule,
    DiagnosticsModule,
    ExternalDataModule,
    IntegrationsModule,
    InboundWebhooksModule,
    InboundWebhookProductionModule,
    InboundWebhookReplayModule,
    ConversionRulesModule,
    LeadsModule,
    ReportingModule,
    ReportSyncModule,
    WebhooksModule,
    OpsAlertsModule,
    LicenseClientModule,
    OnboardingModule,
    TemplateVersionModule,
  ],
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestDurationInterceptor,
    },
  ],
})
export class AppModule {}
