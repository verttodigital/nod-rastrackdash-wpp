import "reflect-metadata";
import { PrismaService } from "../common/prisma/prisma.service";
import { InboundWebhookPayloadEncryptionService } from "../inbound-webhooks/inbound-webhook-payload-encryption.service";
import { UazapiConversionBridgeService } from "../inbound-webhooks/uazapi-conversion-bridge.service";
import { MetaTokenEncryptionService } from "../integrations/meta/meta-token-encryption.service";
import { UazapiLabelOperationsService } from "../integrations/whatsapp-providers/uazapi-label-operations.service";
import { ReportSyncOps } from "../report-sync/report-sync-ops";
import { ReportSyncRepository } from "../report-sync/report-sync.repository";

export function parseProvisionArgs(args: string[]): {
  apply: boolean;
  expectedRules?: number;
} {
  let apply = false;
  let expectedRules: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply") apply = true;
    else if (args[index] === "--expected-rules")
      expectedRules = Number(args[++index]);
    else throw new Error("unknown_argument");
  }
  if (apply && expectedRules !== 6) throw new Error("expected_rules_required");
  return { apply, ...(expectedRules === undefined ? {} : { expectedRules }) };
}

/** Deliberately constructs no Nest application or queue consumers. */
export async function provisionReportSync(
  args = process.argv.slice(2),
): Promise<void> {
  const options = parseProvisionArgs(args);
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    const repository = new ReportSyncRepository(
      prisma,
      new InboundWebhookPayloadEncryptionService(process.env),
    );
    const labels = new UazapiLabelOperationsService(
      prisma,
      new MetaTokenEncryptionService(process.env),
    );
    const ops = new ReportSyncOps(
      repository,
      process.env,
      new UazapiConversionBridgeService(prisma),
      labels,
    );
    console.log(JSON.stringify(await ops.provision(options)));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  provisionReportSync().catch(() => {
    // Config/provider/DB errors can contain credentials; never echo them.
    console.error("report_sync_provision_failed");
    process.exitCode = 1;
  });
}
