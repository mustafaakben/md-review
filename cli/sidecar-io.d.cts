export function readText(file: string): string | null;
export function mutateSidecar<T>(file: string, transform: (text: string | null) => T): { data: T; written: string };
