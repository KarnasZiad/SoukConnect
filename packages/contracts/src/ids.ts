let lastTimestamp = -1;
let sequence = 0;

/**
 * UUID version 7 (RFC 9562): a 48-bit millisecond timestamp, a 12-bit sequence, then random bits.
 * Identifiers sort by creation time, which keeps B-tree indexes and outbox scans in insertion
 * order. Within one millisecond the sequence increases (RFC 9562, method 1), so messages written
 * in the same transaction keep the order in which they were created.
 * Uses the Web Crypto API: available in Node.js 22 and in browsers.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes.subarray(6));
  if (now === lastTimestamp && sequence < 0xfff) {
    sequence += 1;
  } else {
    // A new millisecond starts at a random point of the lower half: room left to count up.
    sequence = (((bytes[6] ?? 0) << 8) | (bytes[7] ?? 0)) & 0x7ff;
    lastTimestamp = now;
  }
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 0x70 | (sequence >> 8); // version 7, then the high bits of the sequence
  bytes[7] = sequence & 0xff;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Creation time of a UUID v7, in milliseconds since the epoch. */
export function timestampOf(id: string): number {
  return Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
}
