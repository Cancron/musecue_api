import { fromBuffer, type Entry, type ZipFile } from 'yauzl';

export interface ZipContents {
  /** Entry names in archive order. */
  names: string[];
  files: Map<string, Buffer>;
  /** Compression method per entry (0 = stored, 8 = deflated). */
  methods: Map<string, number>;
}

/** Reads every entry of a ZIP archive, validating CRCs and sizes. */
export function readZip(archive: Buffer): Promise<ZipContents> {
  return new Promise((resolve, reject) => {
    fromBuffer(
      archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (openError: Error | null, zip: ZipFile) => {
        if (openError) return reject(openError);
        const contents: ZipContents = {
          names: [],
          files: new Map(),
          methods: new Map(),
        };
        zip.on('error', reject);
        zip.on('end', () => resolve(contents));
        zip.on('entry', (entry: Entry) => {
          zip.openReadStream(entry, (streamError, stream) => {
            if (streamError) return reject(streamError);
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('error', reject);
            stream.on('end', () => {
              contents.names.push(entry.fileName);
              contents.files.set(entry.fileName, Buffer.concat(chunks));
              contents.methods.set(entry.fileName, entry.compressionMethod);
              zip.readEntry();
            });
          });
        });
        zip.readEntry();
      },
    );
  });
}
