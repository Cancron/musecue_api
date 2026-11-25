import { Writable } from 'node:stream';
import * as winston from 'winston';

/**
 * Records (and silences) everything written to stdout, stderr and the
 * console - where the application's loggers write - so a test can assert
 * that sensitive values were never logged.
 */
export class OutputCapture {
  private readonly chunks: string[] = [];
  private readonly spies: jest.SpyInstance[] = [];

  start(): void {
    const record = (...args: unknown[]) => {
      this.chunks.push(
        args
          .map((arg) =>
            typeof arg === 'string'
              ? arg
              : Buffer.isBuffer(arg)
                ? arg.toString('utf8')
                : (JSON.stringify(arg) ?? String(arg)),
          )
          .join(' '),
      );
    };
    for (const stream of [process.stdout, process.stderr]) {
      this.spies.push(
        jest.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
          record(chunk);
          return true;
        }),
      );
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      this.spies.push(
        jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          record(...args);
        }),
      );
    }
  }

  text(): string {
    return this.chunks.join('\n');
  }

  stop(): void {
    for (const spy of this.spies.splice(0)) spy.mockRestore();
  }
}

/**
 * Records every entry of a winston logger as JSON, metadata included (what
 * a structured transport such as Loki would ship), not only the fields the
 * console format prints.
 */
export function recordLogEntries(logger: winston.Logger): {
  text(): string;
  stop(): void;
} {
  const entries: string[] = [];
  const transport = new winston.transports.Stream({
    level: 'silly',
    format: winston.format.json(),
    stream: new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        entries.push(chunk.toString());
        callback();
      },
    }),
  });
  logger.add(transport);
  return {
    text: () => entries.join('\n'),
    stop: () => {
      logger.remove(transport);
    },
  };
}
