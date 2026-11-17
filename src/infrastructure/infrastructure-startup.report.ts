import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';
import type { Logger } from 'winston';
import {
  describeInfrastructure,
  type InfrastructureSettings,
} from './infrastructure.config';
import { PostgresJobStore } from './jobs/postgres/postgres-job.store';

export const INFRASTRUCTURE_SETTINGS = Symbol('INFRASTRUCTURE_SETTINGS');

/**
 * Logs the selected drivers once at startup (never credentials). With Redis
 * selected, also warns about PostgreSQL jobs left from a previous
 * REDIS_ENABLED=false run: they only run in PostgreSQL mode, so switching
 * drivers while jobs are pending strands them.
 */
@Injectable()
export class InfrastructureStartupReport implements OnModuleInit {
  constructor(
    @Inject(INFRASTRUCTURE_SETTINGS)
    private readonly settings: InfrastructureSettings,
    private readonly jobs: PostgresJobStore,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
  ) {}

  async onModuleInit(): Promise<void> {
    this.logger.info(describeInfrastructure(this.settings), {
      context: 'Infrastructure',
    });
    if (!this.settings.redisEnabled) return;
    try {
      const pending = await this.jobs.countPending();
      if (pending > 0) {
        this.logger.warn(
          `${pending} PostgreSQL background job(s) are pending but REDIS_ENABLED=true; they only run with REDIS_ENABLED=false`,
          { context: 'Infrastructure', pending },
        );
      }
    } catch {
      // The check is informational; the database may still be starting.
    }
  }
}
