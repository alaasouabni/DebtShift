import { createDebtShiftDatabaseFromUrl, type DebtShiftDatabase } from '@debtshift/database';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  readonly #client;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.#client = createDebtShiftDatabaseFromUrl(config.getOrThrow<string>('DATABASE_URL'));
  }

  get db(): DebtShiftDatabase {
    return this.#client.db;
  }

  async onModuleDestroy(): Promise<void> {
    await this.#client.close();
  }
}
