import type { DurableCommand, OutboxEnvelope } from '@debtshift/database';
import {
  advanceMigrationWithEvidence,
  beginCommand,
  completeCommand,
  failCommand,
  hasFinalizedEvidence,
  type DebtShiftDatabase,
} from '@debtshift/database';
import type { Evidence, EvidenceType, MigrationPhase } from '@debtshift/domain';
import {
  captureTraceContext,
  runWithSafeSpan,
  type SafeSpanHandle,
} from '@debtshift/observability';

export class RetryableCommandError extends Error {
  override readonly name = 'RetryableCommandError';
}

export interface CommandHandler {
  execute(command: DurableCommand): Promise<readonly Evidence[]>;
  onRetryExhausted?(
    command: DurableCommand,
    error: RetryableCommandError,
  ): Promise<readonly Evidence[]>;
}

export interface CommandPersistence {
  begin(commandId: string): Promise<DurableCommand | undefined>;
  hasEvidence(migrationId: string, type: EvidenceType): Promise<boolean>;
  advance(record: Evidence): Promise<MigrationPhase>;
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

  advance(record: Evidence): Promise<MigrationPhase> {
    return advanceMigrationWithEvidence(this.database, record, 'worker', captureTraceContext());
  }

  complete(commandId: string): Promise<void> {
    return completeCommand(this.database, commandId);
  }

  fail(commandId: string, error: unknown, retryable: boolean): Promise<void> {
    return failCommand(this.database, commandId, error, retryable);
  }
}

const expectedEvidenceByCommand: Readonly<Record<string, readonly (readonly EvidenceType[])[]>> = {
  RESERVE_LIQUIDITY: [['LIQUIDITY_RESERVATION'], ['REQUOTE_REQUIRED'], ['MIGRATION_EXPIRED']],
  CANCEL_MIGRATION: [['MIGRATION_CANCELLED']],
  CLOSE_SOURCE: [
    ['SOURCE_CLOSE'],
    ['REQUOTE_REQUIRED'],
    ['RECOVERY_OPENED'],
    ['MIGRATION_EXPIRED'],
  ],
  DISPATCH_TRANSPORT: [['TRANSPORT_ORIGIN'], ['RECOVERY_OPENED']],
  VERIFY_DESTINATION: [['TRANSPORT_DESTINATION'], ['RECOVERY_OPENED']],
  OPEN_TARGET: [['TARGET_POSITION'], ['RECOVERY_OPENED']],
  SETTLE_LIQUIDITY: [['LIQUIDITY_SETTLEMENT', 'LEDGER_RECONCILIATION'], ['RECOVERY_OPENED']],
  FINALIZE_NEAR_RECEIPT: [['NEAR_RECEIPT']],
  EXECUTE_RECOVERY: [['RECOVERY_COMPLETED']],
};

const expectedRetryExhaustionEvidenceByCommand: Readonly<
  Partial<Record<string, readonly (readonly EvidenceType[])[]>>
> = {
  EXECUTE_RECOVERY: [['RECOVERY_OPENED']],
};

export class DurableCommandProcessor {
  constructor(
    private readonly persistence: CommandPersistence,
    private readonly handlers: ReadonlyMap<string, CommandHandler>,
    private readonly log: (event: WorkflowLogEvent) => void = () => undefined,
    private readonly mode?: string,
  ) {}

  async process(message: OutboxEnvelope, finalAttempt = false): Promise<void> {
    await runWithSafeSpan(
      'debtshift.workflow.command',
      {
        attributes: {
          'debtshift.command.final_attempt': finalAttempt,
          ...(this.mode === undefined ? {} : { 'debtshift.mode': this.mode }),
        },
        ...(message.traceContext === undefined ? {} : { parentTraceContext: message.traceContext }),
      },
      async (span) => this.processWithinSpan(message, finalAttempt, span),
    );
  }

  private async processWithinSpan(
    message: OutboxEnvelope,
    finalAttempt: boolean,
    span: SafeSpanHandle,
  ): Promise<void> {
    const command = await this.persistence.begin(message.commandId);
    if (command === undefined) return;
    span.setAttribute('debtshift.command.type', command.type);
    span.setAttribute('debtshift.command.logical_attempt', command.logicalAttempt);
    this.log(commandEvent('workflow_command_started', command, { finalAttempt }));
    const expectedEvidence = expectedEvidenceByCommand[command.type];
    if (expectedEvidence === undefined) {
      const error = new Error(`No evidence contract is defined for ${command.type}.`);
      await this.persistence.fail(command.commandId, error, false);
      this.log(commandEvent('workflow_command_failed', command, { retryable: false }));
      span.fail('UndefinedEvidenceContract');
      return;
    }
    const handler = this.handlers.get(command.type);
    if (handler === undefined) {
      const error = new Error(`No command handler registered for ${command.type}.`);
      await this.persistence.fail(command.commandId, error, false);
      this.log(commandEvent('workflow_command_failed', command, { retryable: false }));
      span.fail('MissingCommandHandler');
      return;
    }

    try {
      const alreadyCompleted = await this.hasAnyExpectedEvidenceGroup(command, expectedEvidence);
      if (alreadyCompleted) {
        await this.persistence.complete(command.commandId);
        this.log(commandEvent('workflow_command_reconciled', command));
        return;
      }

      const producedEvidence = await handler.execute(command);
      this.assertEvidenceContract(command, expectedEvidence, producedEvidence);
      let phase: MigrationPhase | undefined;
      for (const record of producedEvidence) {
        phase = await this.persistence.advance(record);
        this.log(
          commandEvent('workflow_evidence_persisted', command, {
            phase,
            evidenceType: record.type,
            verificationState: record.verificationState,
            ...(record.chainId === undefined ? {} : { chainId: record.chainId.toString() }),
          }),
        );
      }
      await this.persistence.complete(command.commandId);
      this.log(
        commandEvent('workflow_command_succeeded', command, phase === undefined ? {} : { phase }),
      );
    } catch (error) {
      const retryable = error instanceof RetryableCommandError;
      if (retryable && finalAttempt) {
        try {
          const exhaustedEvidence =
            (await handler.onRetryExhausted?.(command, error)) ?? ([] as const);
          if (exhaustedEvidence.length > 0) {
            this.assertEvidenceContract(
              command,
              expectedRetryExhaustionEvidenceByCommand[command.type] ?? expectedEvidence,
              exhaustedEvidence,
            );
            for (const record of exhaustedEvidence) {
              const phase = await this.persistence.advance(record);
              this.log(
                commandEvent('workflow_evidence_persisted', command, {
                  phase,
                  evidenceType: record.type,
                  verificationState: record.verificationState,
                  ...(record.chainId === undefined ? {} : { chainId: record.chainId.toString() }),
                }),
              );
            }
          }
        } catch (exhaustionError) {
          await this.persistence.fail(command.commandId, error, false);
          this.log(
            commandEvent('workflow_command_failed', command, {
              retryable: false,
              retryExhausted: true,
            }),
          );
          throw exhaustionError;
        }
        await this.persistence.fail(command.commandId, error, false);
        this.log(
          commandEvent('workflow_command_failed', command, {
            retryable: false,
            retryExhausted: true,
          }),
        );
        span.fail('RetryExhausted');
        return;
      }
      await this.persistence.fail(command.commandId, error, retryable);
      this.log(commandEvent('workflow_command_failed', command, { retryable }));
      span.fail(retryable ? 'RetryableCommandError' : 'CommandError');
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

export interface WorkflowLogEvent {
  readonly event:
    | 'workflow_command_started'
    | 'workflow_command_reconciled'
    | 'workflow_evidence_persisted'
    | 'workflow_command_succeeded'
    | 'workflow_command_failed';
  readonly migrationId: string;
  readonly commandId: string;
  readonly commandType: string;
  readonly logicalAttempt: number;
  readonly phase?: MigrationPhase;
  readonly chainId?: string;
  readonly evidenceType?: EvidenceType;
  readonly verificationState?: Evidence['verificationState'];
  readonly finalAttempt?: boolean;
  readonly retryable?: boolean;
  readonly retryExhausted?: boolean;
}

function commandEvent(
  event: WorkflowLogEvent['event'],
  command: DurableCommand,
  details: Omit<
    WorkflowLogEvent,
    'event' | 'migrationId' | 'commandId' | 'commandType' | 'logicalAttempt'
  > = {},
): WorkflowLogEvent {
  return {
    event,
    migrationId: command.migrationId,
    commandId: command.commandId,
    commandType: command.type,
    logicalAttempt: command.logicalAttempt,
    ...details,
  };
}
