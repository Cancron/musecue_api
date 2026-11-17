import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  JobHandlerRegistry,
  MissingJobHandlerError,
  registerJobHandler,
} from './job-handler.registry';
import type { JobExecution, JobHandler } from './job.types';

const execution = { name: 'job', data: {} } as JobExecution<unknown>;

describe('JobHandlerRegistry', () => {
  it('holds jobs until the application has started, then runs the handler', async () => {
    const registry = new JobHandlerRegistry();
    const process = jest.fn().mockResolvedValue(undefined);
    const handler: JobHandler = { process };
    registry.register('email', handler);

    const run = registry.run('email', execution);
    await new Promise((resolve) => setImmediate(resolve));
    expect(process.mock.calls).toHaveLength(0);

    registry.onApplicationBootstrap();
    await run;
    expect(process.mock.calls).toContainEqual([execution]);
  });

  it('fails jobs of a queue without a handler', async () => {
    const registry = new JobHandlerRegistry();
    registry.onApplicationBootstrap();
    await expect(registry.run('makeup-ai', execution)).rejects.toBeInstanceOf(
      MissingJobHandlerError,
    );
    expect(registry.has('makeup-ai')).toBe(false);
  });

  it('refuses a second handler for the same queue', () => {
    const registry = new JobHandlerRegistry();
    registry.register('email', { process: jest.fn() });
    expect(() => registry.register('email', { process: jest.fn() })).toThrow(
      'already registered',
    );
  });

  it('registers a module handler through registerJobHandler', async () => {
    class ExportHandler implements JobHandler {
      process = jest.fn().mockResolvedValue(undefined);
    }
    @Module({
      providers: [
        JobHandlerRegistry,
        ExportHandler,
        registerJobHandler('privacy-export', ExportHandler),
      ],
    })
    class FeatureModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [FeatureModule],
    }).compile();
    await moduleRef.createNestApplication().init();
    const registry = moduleRef.get(JobHandlerRegistry);

    expect(registry.get('privacy-export')).toBe(moduleRef.get(ExportHandler));
    await registry.run('privacy-export', execution);
    expect(moduleRef.get(ExportHandler).process).toHaveBeenCalledTimes(1);
  });
});
