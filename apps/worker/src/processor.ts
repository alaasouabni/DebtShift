import type { DurableCommand, OutboxEnvelope } from '@debtshift/database';
import {
  advanceMigrationWithEvidence,
  beginCommand,
  completeCommand,
  failCommand,
  hasFinalizedEvidence,
  type DebtShiftDatabase,
} from '@debtshift/database';
import type { Evidence, EvidenceType } from '@debtshift/domain';

export class RetryableCommandError extends Error {
  override readonly name = 'RetryableCommandError';
}

export interface CommandHandler {
  execute(command: DurableCommand): Promise<readonly Evidence[]>;
}

export interface CommandPersistence {
  begin(commandId: string): Promise<DurableCommand | undefined>;
  hasEvidence(migrationId: string, type: EvidenceType): Promise<boolean>;
  advance(record: Evidence): Promise<void>;
  complete(commandId: string): Promise<void>;
  fail(commandId: string, error: unknown, retryable: boolean): Promise<void>;
}

export class PostgresCommandPersistence implements CommandPersistence {
  constructor(private readonly database: DebtShiftDatabase) {}

  begin(commandId: string): Promise<DurableCommand | undefined> {
    return beginCommand(this.database, commandId);
  }

  hasEvidence(migrationId: string, type: EvidenceType): Promise<boolean> {
    return hasFinalizedEvidence(this.database, migrationId, type);
  }

  async advance(record: Evidence): Promise<void> {
    await advanceMigrationWithEvidence(this.database, record, 'worker');
  }

  complete(commandId: string): Promise<void> {
    return completeCommand(this.database, commandId);
  }

  fail(commandId: string, error: unknown, retryable: boolean): Promise<void> {
    return failCommand(this.database, commandId, error, retryable);
  }
}

const expectedEvidenceByCommand: Readonly<Record<string, readonly (readonly EvidenceType[])[]>> = {
  RESERVE_LIQUIDITY: [['LIQUIDITY_RESERVATION'], ['REQUOTE_REQUIRED']],
  CLOSE_SOURCE: [['SOURCE_CLOSE'], ['REQUOTE_REQUIRED'], ['RECOVERY_OPENED']],
  DISPATCH_TRANSPORT: [['TRANSPORT_ORIGIN'], ['RECOVERY_OPENED']],
  VERIFY_DESTINATION: [['TRANSPORT_DESTINATION'], ['RECOVERY_OPENED']],
  OPEN_TARGET: [['TARGET_POSITION'], ['RECOVERY_OPENED']],
  SETTLE_LIQUIDITY: [['LIQUIDITY_SETTLEMENT', 'LEDGER_RECONCILIATION'], ['RECOVERY_OPENED']],
  FINALIZE_NEAR_RECEIPT: [['NEAR_RECEIPT']],
  EXECUTE_RECOVERY: [['RECOVERY_COMPLETED']],
};

export class DurableCommandProcessor {
  constructor(
    private readonly persistence: CommandPersistence,
    private readonly handlers: ReadonlyMap<string, CommandHandler>,
  ) {}

  async process(message: OutboxEnvelope): Promise<void> {
    const command = await this.persistence.begin(message.commandId);
    if (command === undefined) return;
    const expectedEvidence = expectedEvidenceByCommand[command.type];
    if (expectedEvidence === undefined) {
      const error = new Error(`No evidence contract is defined for ${command.type}.`);
      await this.persistence.fail(command.commandId, error, false);
      return;
    }

    try {
      const alreadyCompleted = await this.hasAnyExpectedEvidenceGroup(command, expectedEvidence);
      if (alreadyCompleted) {
        await this.persistence.complete(command.commandId);
        return;
      }

      const handler = this.handlers.get(command.type);
      if (handler === undefined)
        throw new Error(`No command handler registered for ${command.type}.`);
      const producedEvidence = await handler.execute(command);
      this.assertEvidenceContract(command, expectedEvidence, producedEvidence);
      for (const record of producedEvidence) await this.persistence.advance(record);
      await this.persistence.complete(command.commandId);
    } catch (error) {
      const retryable = error instanceof RetryableCommandError;
      await this.persistence.fail(command.commandId, error, retryable);
      if (retryable) throw error;
    }
  }

  private async hasAnyExpectedEvidenceGroup(
    command: DurableCommand,
    expectedEvidence: readonly (readonly EvidenceType[])[],
  ): Promise<boolean> {
    const groupChecks = await Promise.all(
      expectedEvidence.map(async (group) => {
        const checks = await Promise.all(
          group.map((type) => this.persistence.hasEvidence(command.migrationId, type)),
        );
        return checks.every(Boolean);
      }),
    );
    return groupChecks.some(Boolean);
  }

  private assertEvidenceContract(
    command: DurableCommand,
    expectedEvidence: readonly (readonly EvidenceType[])[],
    records: readonly Evidence[],
  ): void {
    const producedTypes = new Set(records.map((record) => record.type));
    const satisfiesContract = expectedEvidence.some((group) =>
      group.every((type) => producedTypes.has(type)),
    );
    if (!satisfiesContract) {
      throw new Error(`Handler ${command.type} did not satisfy its evidence contract.`);
    }
    for (const record of records) {
      if (record.migrationId !== command.migrationId) {
        throw new Error(`Handler ${command.type} produced evidence for another migration.`);
      }
      if (record.verificationState !== 'FINALIZED' && record.verificationState !== 'RETRACTED') {
        throw new Error(
          `Handler ${command.type} produced unsupported ${record.verificationState} command evidence.`,
        );
      }
    }
  }
}
