// ABOUTME: Minimal type declarations for the parts of snarkjs, ffjavascript and binfileutils the tooling uses.
// ABOUTME: These packages ship no TypeScript types; only the functions called from tool/src are declared.

declare module 'snarkjs' {
  type Logger = { debug?: (...a: unknown[]) => void; info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void } | undefined;
  export const zKey: {
    newZKey(r1cs: string, ptau: string, zkey: string, logger?: Logger): Promise<Uint8Array | false>;
    contribute(oldZkey: string, newZkey: string, name: string, entropy: string, logger?: Logger): Promise<Uint8Array | false>;
    beacon(oldZkey: string, newZkey: string, name: string, beaconHashHex: string, numIterationsExp: number, logger?: Logger): Promise<Uint8Array | false>;
    verifyFromR1cs(r1cs: string, ptau: string, zkey: string, logger?: Logger): Promise<boolean>;
    exportVerificationKey(zkey: string, logger?: Logger): Promise<Record<string, unknown>>;
  };
  export const powersOfTau: {
    newAccumulator(curve: unknown, power: number, ptau: string, logger?: Logger): Promise<unknown>;
    contribute(oldPtau: string, newPtau: string, name: string, entropy: string, logger?: Logger): Promise<unknown>;
    preparePhase2(oldPtau: string, newPtau: string, logger?: Logger): Promise<unknown>;
    verify(ptau: string, logger?: Logger): Promise<boolean>;
  };
  export const curves: {
    getCurveFromName(name: string): Promise<unknown>;
  };
}

declare module 'ffjavascript' {
  export interface CurveGroup {
    F: { n8: number };
    g: unknown;
    fromRprLEM(buff: Uint8Array, offset: number): unknown;
    fromRprUncompressed(buff: Uint8Array, offset: number): unknown;
    toRprUncompressed(buff: Uint8Array, offset: number, p: unknown): void;
    fromRng(rng: unknown): unknown;
    timesFr(p: unknown, s: Uint8Array): unknown;
    toAffine(p: unknown): unknown;
    neg(p: unknown): unknown;
    eq(a: unknown, b: unknown): boolean;
    isZero(p: unknown): boolean;
  }
  export interface Curve {
    q: bigint;
    G1: CurveGroup;
    G2: CurveGroup;
    Fr: { e(v: bigint | number | string): Uint8Array; fromRng(rng: unknown): Uint8Array };
    pairingEq(...args: unknown[]): Promise<boolean>;
    terminate(): Promise<void>;
  }
  export function buildBn128(singleThread?: boolean): Promise<Curve>;
  export class ChaCha {
    constructor(seed: number[]);
  }
}

declare module '@iden3/binfileutils' {
  export interface FastFile {
    pos: number;
    read(n: number): Promise<Uint8Array>;
    readULE32(): Promise<number>;
    close(): Promise<void>;
  }
  export function readBinFile(fileName: string, type: string, maxVersion: number): Promise<{ fd: FastFile; sections: unknown }>;
  export function startReadUniqueSection(fd: FastFile, sections: unknown, idSection: number): Promise<void>;
  export function endReadSection(fd: FastFile, noCheck?: boolean): Promise<void>;
  export function readBigInt(fd: FastFile, n8: number): Promise<bigint>;
}
