/**
 * Extract one raw Elements TxOut from a consensus-serialized transaction.
 *
 * Elements transactions encode the witness flag immediately after the version,
 * followed by the input and output vectors. A TxOut is the concatenation of
 * asset, value, nonce, and a CompactSize-prefixed scriptPubKey; its rangeproof
 * and surjection proof live later in the output-witness vector and are therefore
 * deliberately excluded here.
 */
export function extractElementsTxOut(transaction: Uint8Array, vout: number): Uint8Array {
  if (!Number.isSafeInteger(vout) || vout < 0) {
    throw new Error("invalid Elements output index");
  }

  const cursor = new Cursor(transaction);
  cursor.skip(4, "transaction version");
  const witnessFlag = cursor.byte("witness flag");
  if (witnessFlag !== 0 && witnessFlag !== 1) {
    throw new Error("invalid Elements transaction witness flag");
  }

  const inputCount = cursor.compactSize("input count");
  for (let index = 0; index < inputCount; index += 1) skipInput(cursor, index);

  const outputCount = cursor.compactSize("output count");
  if (vout >= outputCount) throw new Error("Elements output index is out of range");

  let selected: Uint8Array | null = null;
  for (let index = 0; index < outputCount; index += 1) {
    const start = cursor.offset;
    skipTxOut(cursor, index);
    if (index === vout) selected = transaction.slice(start, cursor.offset);
  }

  // Lock time follows the output vector. Output witnesses, when present, come
  // after it and are intentionally not parsed or included in the returned slice.
  cursor.skip(4, "transaction lock time");
  if (!selected) throw new Error("Elements output was not found");
  return selected;
}

function skipInput(cursor: Cursor, index: number): void {
  cursor.skip(32, `input ${index} txid`);
  const encodedVout = cursor.u32(`input ${index} vout`);
  cursor.varBytes(`input ${index} scriptSig`);
  cursor.skip(4, `input ${index} sequence`);

  // Elements stores pegin and issuance flags in the two high bits of vout.
  // Coinbase's all-ones vout is special and carries no issuance payload.
  if (encodedVout !== 0xffff_ffff && (encodedVout & 0x8000_0000) !== 0) {
    cursor.skip(32, `input ${index} issuance blinding nonce`);
    cursor.skip(32, `input ${index} issuance entropy`);
    skipConfidentialValue(cursor, `input ${index} issuance amount`);
    skipConfidentialValue(cursor, `input ${index} issuance inflation keys`);
  }
}

function skipTxOut(cursor: Cursor, index: number): void {
  skipConfidentialAsset(cursor, `output ${index} asset`);
  skipConfidentialValue(cursor, `output ${index} value`);
  skipConfidentialNonce(cursor, `output ${index} nonce`);
  cursor.varBytes(`output ${index} scriptPubKey`);
}

function skipConfidentialAsset(cursor: Cursor, label: string): void {
  const prefix = cursor.byte(`${label} prefix`);
  if (prefix === 0x00) return;
  if (prefix === 0x01 || prefix === 0x0a || prefix === 0x0b) {
    cursor.skip(32, label);
    return;
  }
  throw new Error(`invalid confidential asset prefix in ${label}`);
}

function skipConfidentialValue(cursor: Cursor, label: string): void {
  const prefix = cursor.byte(`${label} prefix`);
  if (prefix === 0x00) return;
  if (prefix === 0x01) {
    cursor.skip(8, label);
    return;
  }
  if (prefix === 0x08 || prefix === 0x09) {
    cursor.skip(32, label);
    return;
  }
  throw new Error(`invalid confidential value prefix in ${label}`);
}

function skipConfidentialNonce(cursor: Cursor, label: string): void {
  const prefix = cursor.byte(`${label} prefix`);
  if (prefix === 0x00) return;
  if (prefix === 0x01 || prefix === 0x02 || prefix === 0x03) {
    cursor.skip(32, label);
    return;
  }
  throw new Error(`invalid confidential nonce prefix in ${label}`);
}

class Cursor {
  offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  byte(label: string): number {
    this.require(1, label);
    return this.bytes[this.offset++];
  }

  u32(label: string): number {
    this.require(4, label);
    const value =
      this.bytes[this.offset] |
      (this.bytes[this.offset + 1] << 8) |
      (this.bytes[this.offset + 2] << 16) |
      (this.bytes[this.offset + 3] << 24);
    this.offset += 4;
    return value >>> 0;
  }

  compactSize(label: string): number {
    const prefix = this.byte(label);
    if (prefix < 0xfd) return prefix;
    if (prefix === 0xfd) {
      this.require(2, label);
      const value = this.bytes[this.offset] | (this.bytes[this.offset + 1] << 8);
      this.offset += 2;
      if (value < 0xfd) throw new Error(`non-canonical CompactSize in ${label}`);
      return value;
    }
    if (prefix === 0xfe) {
      const value = this.u32(label);
      if (value <= 0xffff) throw new Error(`non-canonical CompactSize in ${label}`);
      return value;
    }

    this.require(8, label);
    let value = 0n;
    for (let index = 0; index < 8; index += 1) {
      value |= BigInt(this.bytes[this.offset + index]) << BigInt(index * 8);
    }
    this.offset += 8;
    if (value <= 0xffff_ffffn) throw new Error(`non-canonical CompactSize in ${label}`);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`CompactSize is too large in ${label}`);
    return Number(value);
  }

  varBytes(label: string): void {
    this.skip(this.compactSize(`${label} length`), label);
  }

  skip(length: number, label: string): void {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`invalid length in ${label}`);
    this.require(length, label);
    this.offset += length;
  }

  private require(length: number, label: string): void {
    if (length > this.bytes.length - this.offset) {
      throw new Error(`truncated Elements transaction while reading ${label}`);
    }
  }
}
