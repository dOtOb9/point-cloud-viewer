import type { ReactNode } from "react";

/** 選択肢1つ分の行(ラジオ・チェック共通の見た目)。 */
export function OptionRow({ children, disabled = false }: { children: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex min-h-11 items-center gap-3 rounded px-2 text-sm hover:bg-black/5 dark:hover:bg-white/10 ${disabled ? "opacity-50" : ""}`}>
      {children}
    </label>
  );
}
