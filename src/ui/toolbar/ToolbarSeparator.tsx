/**
 * A thin vertical line between toolbar sections. It takes the place of the border the old
 * ribbon groups drew; there are no group headings any more.
 */
export function ToolbarSeparator() {
  return <div role="separator" aria-orientation="vertical" className="mx-2 w-px shrink-0 self-stretch bg-black/10 dark:bg-white/10" />;
}
