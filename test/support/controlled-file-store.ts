import type {
  FileRemoval,
  PrivateFileStore,
} from '../../src/storage/private-file-store';

export interface StorageOperation {
  op: 'list' | 'remove' | 'prune';
  /** Owner ID (list, prune) or storage key (remove). */
  target: string;
  /** What the store answered: a removal result, a listing size, or an error. */
  result: string;
}

type Scripted = 'MISSING' | Error;

/**
 * An in-memory private storage adapter whose answers tests control, and which
 * records every operation performed on it.
 *
 * - `add()` puts files in storage; keys start with the owner ID.
 * - `respond(key, ...answers)` scripts the next answers to `remove(key)`:
 *   an Error is thrown, 'MISSING' reports the file as already gone. After the
 *   scripted answers, the store behaves normally.
 * - `failListing()` / `failPruning()` make the next listing / pruning throw.
 * - `onRemove` lets a test change storage while the cleanup runs (for
 *   example a worker writing a temporary file).
 */
export class ControlledFileStore implements PrivateFileStore {
  readonly files = new Set<string>();
  readonly operations: StorageOperation[] = [];
  onRemove: ((key: string) => void) | null = null;
  private readonly scripted = new Map<string, Scripted[]>();
  private readonly listingFailures: Error[] = [];
  private readonly pruningFailures: Error[] = [];

  constructor(private readonly log?: StorageOperation[]) {}

  add(...keys: string[]): this {
    for (const key of keys) this.files.add(key);
    return this;
  }

  respond(key: string, ...answers: Scripted[]): this {
    this.scripted.set(key, [...(this.scripted.get(key) ?? []), ...answers]);
    return this;
  }

  failListing(error: Error): this {
    this.listingFailures.push(error);
    return this;
  }

  failPruning(error: Error): this {
    this.pruningFailures.push(error);
    return this;
  }

  /** Keys actually removed (result DELETED), in order. */
  removed(): string[] {
    return this.operations
      .filter((operation) => operation.op === 'remove')
      .filter((operation) => operation.result === 'DELETED')
      .map((operation) => operation.target);
  }

  /** Every key a removal was attempted for (any result), in order. */
  removalAttempts(): string[] {
    return this.operations
      .filter((operation) => operation.op === 'remove')
      .map((operation) => operation.target);
  }

  private record(operation: StorageOperation) {
    this.operations.push(operation);
    this.log?.push(operation);
  }

  listOwnerFiles(ownerId: string): Promise<string[]> {
    const failure = this.listingFailures.shift();
    if (failure) {
      this.record({ op: 'list', target: ownerId, result: failure.name });
      return Promise.reject(failure);
    }
    const keys = [...this.files]
      .filter((key) => key.startsWith(`${ownerId}/`))
      .sort();
    this.record({ op: 'list', target: ownerId, result: String(keys.length) });
    return Promise.resolve(keys);
  }

  remove(storageKey: string): Promise<FileRemoval> {
    const answer = this.scripted.get(storageKey)?.shift();
    if (answer instanceof Error) {
      this.record({ op: 'remove', target: storageKey, result: answer.name });
      return Promise.reject(answer);
    }
    let result: FileRemoval;
    if (answer === 'MISSING' || !this.files.has(storageKey)) {
      this.files.delete(storageKey);
      result = 'MISSING';
    } else {
      this.files.delete(storageKey);
      result = 'DELETED';
    }
    this.record({ op: 'remove', target: storageKey, result });
    this.onRemove?.(storageKey);
    return Promise.resolve(result);
  }

  removeEmptyOwnerDirectories(ownerId: string): Promise<void> {
    const failure = this.pruningFailures.shift();
    this.record({
      op: 'prune',
      target: ownerId,
      result: failure ? failure.name : 'OK',
    });
    return failure ? Promise.reject(failure) : Promise.resolve();
  }
}
