/**
 * Extract one raw Elements TxOut from a consensus-serialized transaction.
 *
 * Elements transactions encode the witness flag immediately after the version,
 * followed by the input and output vectors. A TxOut is the concatenation of
 * asset, value, nonce, and a CompactSize-prefixed scriptPubKey; its rangeproof
 * and surjection proof live later in the output-witness vector and are therefore
 * deliberately excluded here.
 */
export type ElementsTransactionOutput = {
  serialized: Uint8Array;
  scriptPubKey: Uint8Array;
  explicitAsset: boolean;
  explicitValue: bigint | null;
  nullNonce: boolean;
};

export type ElementsTransactionShape = {
  inputCount: number;
  outputs: ElementsTransactionOutput[];
};

/** Inspect the non-witness transaction shape needed by trusted history decoders. */
export function inspectElementsTransaction(transaction: Uint8Array): ElementsTransactionShape {
  const cursor = new Cursor(transaction);
  cursor.skip(4, "transaction version");
  const witnessFlag = cursor.byte("witness flag");
  if (witnessFlag !== 0 && witnessFlag !== 1) {
    throw new Error("invalid Elements transaction witness flag");
  }

  const inputCount = cursor.compactSize("input count");
  for (let index = 0; index < inputCount; index += 1) skipInput(cursor, index);

  const outputCount = cursor.compactSize("output count");
  const outputs: ElementsTransactionOutput[] = [];
  for (let index = 0; index < outputCount; index += 1) {
    const start = cursor.offset;
    const output = readTxOut(cursor, index);
    outputs.push({
      ...output,
      serialized: transaction.slice(start, cursor.offset),
    });
  }

  // Lock time follows the output vector. Output witnesses, when present, come
  // after it and are intentionally not parsed.
  cursor.skip(4, "transaction lock time");
  return { inputCount, outputs };
}

export function extractElementsTxOut(transaction: Uint8Array, vout: number): Uint8Array {
  if (!Number.isSafeInteger(vout) || vout < 0) {
    throw new Error("invalid Elements output index");
  }
  const output = inspectElementsTransaction(transaction).outputs[vout];
  if (!output) throw new Error("Elements output index is out of range");
  return output.serialized;
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

function readTxOut(
  cursor: Cursor,
  index: number,
): Omit<ElementsTransactionOutput, "serialized"> {
  const assetPrefix = skipConfidentialAsset(cursor, `output ${index} asset`);
  const value = readConfidentialValue(cursor, `output ${index} value`);
  const noncePrefix = skipConfidentialNonce(cursor, `output ${index} nonce`);
  return {
    scriptPubKey: cursor.varBytes(`output ${index} scriptPubKey`),
    explicitAsset: assetPrefix === 0x01,
    explicitValue: value,
    nullNonce: noncePrefix === 0x00,
  };
}

function skipConfidentialAsset(cursor: Cursor, label: string): number {
  const prefix = cursor.byte(`${label} prefix`);
  if (prefix === 0x00) return prefix;
  if (prefix === 0x01 || prefix === 0x0a || prefix === 0x0b) {
    cursor.skip(32, label);
    return prefix;
  }
  throw new Error(`invalid confidential asset prefix in ${label}`);
}

function skipConfidentialValue(cursor: Cursor, label: string): void {
  readConfidentialValue(cursor, label);
}

function readConfidentialValue(cursor: Cursor, label: string): bigint | null {
  const prefix = cursor.byte(`${label} prefix`);
  if (prefix === 0x00) return null;
  if (prefix === 0x01) {
    return cursor.u64be(label);
  }
  if (prefix === 0x08 || prefix === 0x09) {
    cursor.skip(32, label);
    return null;
  }
  throw new Error(`invalid confidential value prefix in ${label}`);
}

function skipConfidentialNonce(cursor: Cursor, label: string): number {
  const prefix = cursor.byte(`${label} prefix`);
  if (prefix === 0x00) return prefix;
  if (prefix === 0x01 || prefix === 0x02 || prefix === 0x03) {
    cursor.skip(32, label);
    return prefix;
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

  u64be(label: string): bigint {
    const bytes = this.take(8, label);
    let value = 0n;
    for (const byte of bytes) value = (value << 8n) | BigInt(byte);
    return value;
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

  varBytes(label: string): Uint8Array {
    return this.take(this.compactSize(`${label} length`), label);
  }

  take(length: number, label: string): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) throw new Error(`invalid length in ${label}`);
    this.require(length, label);
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  skip(length: number, label: string): void {
    this.take(length, label);
  }

  private require(length: number, label: string): void {
    if (length > this.bytes.length - this.offset) {
      throw new Error(`truncated Elements transaction while reading ${label}`);
    }
  }
}
