import { Module } from "@nestjs/common";
import { WorkLedgerController } from "./work-ledger.controller.js";
import { WorkLedgerService } from "./work-ledger.service.js";

@Module({
  controllers: [WorkLedgerController],
  providers: [WorkLedgerService],
})
export class WorkLedgerModule {}
