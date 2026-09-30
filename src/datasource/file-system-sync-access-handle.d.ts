// TypeScript標準の`lib.dom.d.ts`には、まだ`FileSystemSyncAccessHandle`
// (Worker専用の同期I/O、OPFS)の型が無い(2026-09時点、TypeScript ~6.0.3で確認)。
// WHATWG File System Standard / MDNの仕様に基づき最小限を宣言する。
// 出典:
// - https://fs.spec.whatwg.org/ (FileSystemSyncAccessHandle, FileSystemFileHandle.createSyncAccessHandle)
// - https://developer.mozilla.org/en-US/docs/Web/API/FileSystemSyncAccessHandle
//
// 詳細・対応ブラウザは `TaskSheets/M4-import-and-conversion.md` の M4-6a 7節を参照。
// `import`/`export`を書かないことで、このファイル全体がグローバルなアンビエント
// 宣言として扱われる(モジュールにならない)。

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