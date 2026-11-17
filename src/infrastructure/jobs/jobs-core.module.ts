import { Global, Module } from '@nestjs/common';
import { JobHandlerRegistry } from './job-handler.registry';

/** The queue-to-handler registry shared by feature modules and both drivers. */
@Global()
@Module({
  providers: [JobHandlerRegistry],
  exports: [JobHandlerRegistry],
})
export class JobsCoreModule {}
