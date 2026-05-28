import { decode, encode } from "cborg";

export function encodeCbor(value: unknown): Uint8Array {
  const encoded = encode(value);
  return encoded instanceof Uint8Array ? encoded : new Uint8Array(encoded);
}

export function decodeCbor(bytes: Uint8Array | null): unknown {
  if (!bytes) return undefined;
  try {
    return decode(bytes);
  } catch {
    return undefined;
  }
}
