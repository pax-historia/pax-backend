export function encodeCbor(value: unknown): Uint8Array {
  return encodeUtf8(JSON.stringify(value));
}

export function decodeCbor(bytes: Uint8Array | null): unknown {
  if (!bytes) return undefined;
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

function encodeUtf8(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }

    if (codePoint <= 0x7f) {
      bytes.push(codePoint);
    } else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

function decodeUtf8(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index] ?? 0;
    if (first <= 0x7f) {
      output += String.fromCharCode(first);
      index += 1;
      continue;
    }

    const second = bytes[index + 1];
    if (first >= 0xc2 && first <= 0xdf && isContinuation(second)) {
      output += String.fromCharCode(((first & 0x1f) << 6) | (second & 0x3f));
      index += 2;
      continue;
    }

    const third = bytes[index + 2];
    if (
      first >= 0xe0 &&
      first <= 0xef &&
      isContinuation(second) &&
      isContinuation(third) &&
      !(first === 0xe0 && second < 0xa0) &&
      !(first === 0xed && second >= 0xa0)
    ) {
      output += String.fromCharCode(
        ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f),
      );
      index += 3;
      continue;
    }

    const fourth = bytes[index + 3];
    if (
      first >= 0xf0 &&
      first <= 0xf4 &&
      isContinuation(second) &&
      isContinuation(third) &&
      isContinuation(fourth) &&
      !(first === 0xf0 && second < 0x90) &&
      !(first === 0xf4 && second >= 0x90)
    ) {
      const codePoint =
        ((first & 0x07) << 18) |
        ((second & 0x3f) << 12) |
        ((third & 0x3f) << 6) |
        (fourth & 0x3f);
      output += String.fromCodePoint(codePoint);
      index += 4;
      continue;
    }

    output += "\ufffd";
    index += 1;
  }
  return output;
}

function isContinuation(value: number | undefined): value is number {
  return value !== undefined && value >= 0x80 && value <= 0xbf;
}
