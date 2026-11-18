export function saveSettingIfStorageAllows(save: () => void): void {
  try {
    save();
  } catch {
    return;
  }
}
