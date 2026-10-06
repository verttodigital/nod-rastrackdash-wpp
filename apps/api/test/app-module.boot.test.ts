import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppModule } from "../src/app.module";
import { UazapiLabelOperationsService } from "../src/integrations/whatsapp-providers/uazapi-label-operations.service";
import { ReportSyncService } from "../src/report-sync/report-sync.service";

describe("AppModule boot", () => {
  const previousWebOrigin = process.env.WEB_ORIGIN;

  beforeAll(() => {
    process.env.WEB_ORIGIN = "https://app.example.test";
  });

  afterAll(() => {
    if (previousWebOrigin === undefined) delete process.env.WEB_ORIGIN;
    else process.env.WEB_ORIGIN = previousWebOrigin;
  });

  it("compiles the production module graph without a database", async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    try {
      expect(module.get(UazapiLabelOperationsService)).toBeInstanceOf(
        UazapiLabelOperationsService,
      );
      expect(module.get(ReportSyncService)).toBeInstanceOf(ReportSyncService);
    } finally {
      await module.close();
    }
  });
});
