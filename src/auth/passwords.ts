const encoder = new TextEncoder();
export function textBytes(value: string) {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

export function hex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function fromHex(value: string) {
  return new Uint8Array(
    value.match(/.{2}/g)?.map((pair) => parseInt(pair, 16)) ?? [],
  );
}

export async function hashPassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const stableSalt = new Uint8Array(salt);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: stableSalt, iterations },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

export function constantTimeEqual(left: string, right: string) {
  const a = textBytes(left);
  const b = textBytes(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return difference === 0;
}
