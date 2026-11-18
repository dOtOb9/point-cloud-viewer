interface FileSystemReadWriteOptions {
  at?: number;
}

interface FileSystemSyncAccessHandle {
  read(buffer: BufferSource, options?: FileSystemReadWriteOptions): number;
  write(buffer: BufferSource, options?: FileSystemReadWriteOptions): number;
  truncate(newSize: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
