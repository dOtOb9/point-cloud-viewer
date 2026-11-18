export function buildNodeRequestPath(generation: number, key: string): string {
  return `${generation}/${key}`;
}
