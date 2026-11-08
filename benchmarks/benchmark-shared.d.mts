export function resolveLocalAddress(deviceIp: string): Promise<string>;
export function formatUrlHost(host: string): string;
export function writeBenchmarkResponse(response: unknown, chunk: Uint8Array | string): Promise<boolean>;
export function bytesToMiB(bytes: number): number;
export function roundHundredths(value: number): number;
export function positiveIntegerEnv(name: string, fallback: number): number;
export function nonNegativeIntegerEnv(name: string, fallback: number): number;
export function numberOverride(key: string, name: string): Record<string, number>;
export function listEnv(name: string, fallback: string[]): string[];
