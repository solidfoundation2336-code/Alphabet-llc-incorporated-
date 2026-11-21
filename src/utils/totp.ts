const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(length = 16): string {
  const randomBytes = new Uint8Array(length);
  crypto.getRandomValues(randomBytes);
  let secret = '';
  for (let i = 0; i < length; i++) {
    secret += BASE32_ALPHABET[randomBytes[i] % BASE32_ALPHABET.length];
  }
  return secret;
}

function base32ToBytes(base32: string): Uint8Array {
  const cleaned = base32.toUpperCase().replace(/[^A-Z2-7]/g, '');
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(cleaned[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

export async function generateTotpCode(secret: string, timestampMs = Date.now()): Promise<string> {
  const keyBytes = base32ToBytes(secret);
  const counter = Math.floor(timestampMs / 1000 / 30);
  const counterBytes = new ArrayBuffer(8);
  const view = new DataView(counterBytes);
  view.setUint32(0, Math.floor(counter / 0x100000000), false);
  view.setUint32(4, counter >>> 0, false);

  const rawKey = new Uint8Array(keyBytes).buffer;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    rawKey,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', cryptoKey, counterBytes);
  const hmac = new Uint8Array(signature);
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return otp.toString().padStart(6, '0');
}

export async function verifyTotpCode(secret: string, candidateCode: string): Promise<boolean> {
  const sanitized = candidateCode.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(sanitized)) return false;

  const now = Date.now();
  // Allow +/- 1 30-second window for clock drift
  for (const offsetMs of [-30000, 0, 30000]) {
    const expected = await generateTotpCode(secret, now + offsetMs);
    if (expected === sanitized) {
      return true;
    }
  }
  return false;
}

export function getTotpSecondsRemaining(timestampMs = Date.now()): number {
  const elapsed = Math.floor(timestampMs / 1000) % 30;
  return 30 - elapsed;
}

export function formatOtpAuthUri(accountLabel: string, secret: string): string {
  const issuer = encodeURIComponent('Veridian Ledger');
  const label = encodeURIComponent(accountLabel);
  return `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}
