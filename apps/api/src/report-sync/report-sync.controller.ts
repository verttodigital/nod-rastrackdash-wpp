import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Res,
  UnauthorizedException,
} from "@nestjs/common";
import { RUNTIME_ENV, type RuntimeEnv } from "../common/runtime/runtime.module";
import { bearerMatches } from "./report-sync.contract";
import { ReportSyncService } from "./report-sync.service";

@Controller("integrations/report-sync")
export class ReportSyncController {
  constructor(
    @Inject(ReportSyncService) private readonly sync: ReportSyncService,
    @Inject(RUNTIME_ENV) private readonly env: RuntimeEnv,
  ) {}
  private auth(value: string | undefined) {
    if (!bearerMatches(value, this.env.REPORT_SYNC_BEARER_TOKEN))
      throw new UnauthorizedException("integration_auth_required");
  }
  @Post("intents")
  async accept(
    @Headers("authorization") auth: string | undefined,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
    this.auth(auth);
    const result = await this.sync.accept(body, key);
    response.status(result.duplicate ? 200 : 202);
    return result;
  }
  @Get("intents/:id")
  result(
    @Headers("authorization") auth: string | undefined,
    @Param("id") id: string,
  ) {
    this.auth(auth);
    return this.sync.result(id);
  }
  @Post("baseline")
  @HttpCode(200)
  baseline(
    @Headers("authorization") auth: string | undefined,
    @Body() body: unknown,
  ) {
    this.auth(auth);
    return this.sync.baseline(body);
  }
}
