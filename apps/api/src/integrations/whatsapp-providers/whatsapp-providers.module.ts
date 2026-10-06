import { forwardRef, Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { PrismaModule } from "../../common/prisma/prisma.module";
import { LicenseClientModule } from "../../licensing-client/license-client.module";
import { WorkspacesModule } from "../../workspaces/workspaces.module";
import { INTEGRATION_ENV } from "../integration.types";
import { MetaTokenEncryptionService } from "../meta/meta-token-encryption.service";
import { UazapiAdapter } from "../uazapi/uazapi.adapter";
import { NodApiWhatsappAdapter } from "./nod-api-whatsapp.adapter";
import { UazapiByoAdapter } from "./uazapi-byo.adapter";
import { UazapiLabelOperationsService } from "./uazapi-label-operations.service";
import { WahaWhatsappAdapter } from "./waha-whatsapp.adapter";
import { WhatsappProviderRegistry } from "./whatsapp-provider.registry";
import { WhatsappProvidersBootstrapService } from "./whatsapp-providers-bootstrap.service";
import { WhatsappConnectionsController } from "./whatsapp-connections.controller";
import { WhatsappConnectionsService } from "./whatsapp-connections.service";
import { ZapiWhatsappAdapter } from "./zapi-whatsapp.adapter";
import { InboundWebhooksModule } from "../../inbound-webhooks/inbound-webhooks.module";

export { WhatsappProviderRegistry } from "./whatsapp-provider.registry";
export { UazapiByoAdapter } from "./uazapi-byo.adapter";
export { NodApiWhatsappAdapter } from "./nod-api-whatsapp.adapter";
export { WahaWhatsappAdapter } from "./waha-whatsapp.adapter";
export { ZapiWhatsappAdapter } from "./zapi-whatsapp.adapter";
export type {
  WhatsappProviderAdapter,
  WhatsappProviderConfig,
  WhatsappProviderHealthDto,
  WhatsappProviderId,
} from "./whatsapp-provider.types";

/**
 * Owns the WhatsApp provider registry and registers the adapters that are
 * actually ready for production use: "uazapi_byo" (F5.1), "nod_api"
 * (F5.3b), "waha" (F5.4) and "zapi" (F5.5) — see ./README.md for the
 * plan. No stub adapters remain as of F5.5. Imports LicenseClientModule
 * because NodApiWhatsappAdapter authenticates against the PalmUP broker
 * with the operator's license (LICENSE_KEY +
 * LicenseClientService.getFingerprint()).
 */
@Module({
  imports: [
    AuthModule,
    LicenseClientModule,
    PrismaModule,
    WorkspacesModule,
    forwardRef(() => InboundWebhooksModule),
  ],
  providers: [
    // UazapiAdapter/WahaWhatsappAdapter/ZapiWhatsappAdapter need
    // INTEGRATION_ENV and this module declares no imports of its own
    // (leaf module) — provide it locally, same pattern as every other
    // module that instantiates an INTEGRATION_ENV consumer
    // (integrations.module.ts, inbound-webhooks.module.ts).
    { provide: INTEGRATION_ENV, useValue: process.env },
    UazapiAdapter,
    UazapiByoAdapter,
    UazapiLabelOperationsService,
    NodApiWhatsappAdapter,
    WahaWhatsappAdapter,
    ZapiWhatsappAdapter,
    WhatsappProviderRegistry,
    WhatsappProvidersBootstrapService,
    MetaTokenEncryptionService,
    WhatsappConnectionsService,
  ],
  controllers: [WhatsappConnectionsController],
  exports: [
    UazapiLabelOperationsService,
    WhatsappProviderRegistry,
    UazapiByoAdapter,
    UazapiAdapter,
    NodApiWhatsappAdapter,
    WahaWhatsappAdapter,
    ZapiWhatsappAdapter,
    WhatsappConnectionsService,
  ],
})
export class WhatsappProvidersModule {}
