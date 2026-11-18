export function saveSettingIfStorageAllows(save: () => void): void {
  try {
    save();
  } catch (storageIsUnavailable) {
    void storageIsUnavailable;
  }
}
