import { Module } from "@nestjs/common";
import { EvidenceLedgerController } from "./evidence-ledger.controller.js";
import { EvidenceLedgerService } from "./evidence-ledger.service.js";

@Module({
  controllers: [EvidenceLedgerController],
  providers: [EvidenceLedgerService],
})
export class EvidenceLedgerModule {}
