export type StorageCapability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: "unavailable" };

export interface StorageAdapter {
  probe(): StorageCapability;
  load(key: string): string | null;
  save(key: string, value: string): void;
  remove(key: string): void;
}

export class LocalStorageAdapter implements StorageAdapter {
  constructor(private readonly storage: Storage | undefined) {}

  probe(): StorageCapability {
    if (this.storage === undefined) return { available: false, reason: "unavailable" };
    const key = "review-workbench/1:capability-probe";
    try {
      const previous = this.storage.getItem(key);
      this.storage.setItem(key, "1");
      if (this.storage.getItem(key) !== "1") return { available: false, reason: "unavailable" };
      if (previous === null) this.storage.removeItem(key);
      else this.storage.setItem(key, previous);
      return { available: true };
    } catch {
      return { available: false, reason: "unavailable" };
    }
  }

  load(key: string): string | null {
    if (this.storage === undefined) throw new Error("STORAGE_UNAVAILABLE");
    return this.storage.getItem(key);
  }

  save(key: string, value: string): void {
    if (this.storage === undefined) throw new Error("STORAGE_UNAVAILABLE");
    this.storage.setItem(key, value);
  }

  remove(key: string): void {
    if (this.storage === undefined) throw new Error("STORAGE_UNAVAILABLE");
    this.storage.removeItem(key);
  }
}
