declare module 'circomlibjs' {
  export function buildPoseidon(): Promise<{
    F: {
      toString(value: unknown): string;
    };
    (inputs: (string | number | bigint)[]): unknown;
  }>;

  export function buildBabyjub(): Promise<unknown>;
  export function buildEddsa(): Promise<unknown>;
  export function buildMimcsponge(): Promise<unknown>;
}
