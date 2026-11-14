import { createHash } from 'node:crypto';
import { PassThrough, Readable, Transform, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';

export interface ZipEntryOptions {
  /** Deflate the entry. Already-compressed photos are stored as-is. */
  compress: boolean;
  mtime: Date;
}

export interface ZipArchiveSummary {
  sizeBytes: number;
  sha256: string;
}

/**
 * Streams a ZIP archive into `destination` one entry at a time.
 *
 * `add` resolves once the entry's bytes have been consumed by the archive, so
 * callers that await it hold at most one entry (one photo) in memory. The
 * archive's size and SHA-256 are measured while it is written.
 */
export class PrivacyZipWriter {
  private readonly zip = new ZipFile();
  private readonly hash = createHash('sha256');
  private sizeBytes = 0;
  private readonly completion: Promise<void>;
  private closed = false;

  constructor(destination: Writable) {
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        this.hash.update(chunk);
        this.sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });
    this.completion = pipeline(
      this.zip.outputStream as Readable,
      meter,
      destination,
    );
    // Failures are surfaced through add()/finish(); avoid an unhandled rejection.
    this.completion.catch(() => undefined);
  }

  async add(
    path: string,
    bytes: Buffer,
    options: ZipEntryOptions,
  ): Promise<void> {
    if (this.closed) throw new Error('The archive is already closed');
    const source = new PassThrough();
    const consumed = new Promise<void>((resolve, reject) => {
      source.once('end', resolve);
      source.once('error', reject);
    });
    this.zip.addReadStreamLazy(
      path,
      {
        compress: options.compress,
        mtime: options.mtime,
        size: bytes.length,
      },
      (callback) => callback(null, source),
    );
    source.end(bytes);
    await Promise.race([
      consumed,
      this.completion.then(() => {
        throw new Error('The archive stream closed early');
      }),
    ]);
  }

  async finish(): Promise<ZipArchiveSummary> {
    if (this.closed) throw new Error('The archive is already closed');
    this.closed = true;
    this.zip.end();
    await this.completion;
    return { sizeBytes: this.sizeBytes, sha256: this.hash.digest('hex') };
  }

  /** Stops writing and waits until the destination has been released. */
  async abort(): Promise<void> {
    this.closed = true;
    (this.zip.outputStream as Readable).destroy(
      new Error('Archive generation was aborted'),
    );
    await this.completion.catch(() => undefined);
  }
}
