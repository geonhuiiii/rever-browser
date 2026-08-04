// Dependency-free protobuf wire-format decoder — the `protoc --decode_raw`
// equivalent. Recovers field-number → value structure without a .proto schema.
// Pure functions only (no Electron / CDP) so this stays unit-testable.

export type ProtobufValue =
  | { kind: 'varint'; value: number | string; signed: number | string }
  | { kind: 'fixed64'; hex: string; uint64: number | string; double: number }
  | { kind: 'fixed32'; hex: string; uint32: number; float: number }
  | { kind: 'message'; fields: ProtobufMessage }
  | { kind: 'string'; value: string }
  | { kind: 'bytes'; base64: string; hex: string; length: number }

/** Keys are `#<field-number>`; a repeated field collects into an array. */
export type ProtobufMessage = Record<string, ProtobufValue | ProtobufValue[]>

export interface ProtobufFrame {
  /** gRPC frame flag byte (0 = data, 1 = trailer). Absent when unframed. */
  flag?: number
  trailer?: boolean
  byteLength: number
  fields?: ProtobufMessage
  /** Trailer frames carry ASCII metadata (e.g. `grpc-status: 0`), not protobuf. */
  trailerText?: string
  error?: string
}

export interface ProtobufDecodeOptions {
  /** Force (true) or skip (false) gRPC frame parsing. Auto-detected when omitted. */
  grpcWeb?: boolean
  /** Max nesting depth for length-delimited recursion (default 8). */
  maxDepth?: number
}

export interface ProtobufDecodeResult {
  grpcWeb: boolean
  byteLength: number
  frames: ProtobufFrame[]
}

const DEFAULT_MAX_DEPTH = 8

function readVarint(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let p = pos
  while (p < buf.length) {
    const b = buf[p++]
    result |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) return [result, p]
    shift += 7n
    if (shift > 63n) throw new Error('varint too long')
  }
  throw new Error('truncated varint')
}

function num(v: bigint): number | string {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(v)
    : v.toString()
}

/** protobuf zigzag: sint32/sint64 encode negatives as small unsigned varints. */
function zigzag(v: bigint): bigint {
  return (v >> 1n) ^ -(v & 1n)
}

/**
 * Strict text test: valid UTF-8 with no control characters other than tab /
 * newline / carriage return. Nested messages almost always contain a length or
 * tag byte in the control range, so text wins only when it really is text.
 */
function asText(slice: Buffer): string | null {
  const s = slice.toString('utf8')
  if (!Buffer.from(s, 'utf8').equals(slice)) return null
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) return null
  return s
}

function decodeMessage(buf: Buffer, depth: number, maxDepth: number): ProtobufMessage {
  const out: ProtobufMessage = {}
  let pos = 0
  while (pos < buf.length) {
    const [tag, afterTag] = readVarint(buf, pos)
    pos = afterTag
    const field = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (field === 0) throw new Error('zero field number')

    let val: ProtobufValue
    if (wire === 0) {
      const [v, p] = readVarint(buf, pos)
      pos = p
      val = { kind: 'varint', value: num(v), signed: num(zigzag(v)) }
    } else if (wire === 1) {
      if (pos + 8 > buf.length) throw new Error('truncated 64-bit value')
      const slice = buf.subarray(pos, pos + 8)
      pos += 8
      val = {
        kind: 'fixed64',
        hex: '0x' + slice.toString('hex'),
        uint64: num(slice.readBigUInt64LE(0)),
        double: slice.readDoubleLE(0)
      }
    } else if (wire === 2) {
      const [len, p] = readVarint(buf, pos)
      pos = p
      const l = Number(len)
      if (pos + l > buf.length) throw new Error('truncated length-delimited value')
      const slice = buf.subarray(pos, pos + l)
      pos += l
      val = interpret(slice, depth + 1, maxDepth)
    } else if (wire === 5) {
      if (pos + 4 > buf.length) throw new Error('truncated 32-bit value')
      const slice = buf.subarray(pos, pos + 4)
      pos += 4
      val = {
        kind: 'fixed32',
        hex: '0x' + slice.toString('hex'),
        uint32: slice.readUInt32LE(0),
        float: slice.readFloatLE(0)
      }
    } else {
      // 3/4 = start/end group (deprecated since proto2), 6/7 = reserved.
      throw new Error(`unsupported wire type ${wire}`)
    }

    const key = `#${field}`
    const cur = out[key]
    if (cur === undefined) out[key] = val
    else if (Array.isArray(cur)) cur.push(val)
    else out[key] = [cur, val]
  }
  return out
}

/** A length-delimited chunk is one of: string, nested message, or raw bytes. */
function interpret(slice: Buffer, depth: number, maxDepth: number): ProtobufValue {
  const text = asText(slice)
  if (text !== null) return { kind: 'string', value: text }
  if (depth < maxDepth) {
    try {
      const fields = decodeMessage(slice, depth, maxDepth)
      if (Object.keys(fields).length > 0) return { kind: 'message', fields }
    } catch {
      // not a nested message — fall through to raw bytes
    }
  }
  return {
    kind: 'bytes',
    base64: slice.toString('base64'),
    hex: slice.toString('hex'),
    length: slice.length
  }
}

/**
 * gRPC / gRPC-web framing: each frame is a 1-byte flag (0 = data, 1 = trailer)
 * plus a 4-byte big-endian length. Returns null when the buffer is not an exact
 * sequence of frames (i.e. it is a bare protobuf message).
 */
export function splitGrpcFrames(buf: Buffer): { flag: number; body: Buffer }[] | null {
  const frames: { flag: number; body: Buffer }[] = []
  let pos = 0
  while (pos < buf.length) {
    if (pos + 5 > buf.length) return null
    const flag = buf[pos]
    if (flag !== 0 && flag !== 1) return null
    const len = buf.readUInt32BE(pos + 1)
    if (pos + 5 + len > buf.length) return null
    frames.push({ flag, body: buf.subarray(pos + 5, pos + 5 + len) })
    pos += 5 + len
  }
  return frames.length > 0 ? frames : null
}

/**
 * Decode raw bytes as protobuf, transparently handling gRPC/gRPC-web framing.
 * Never throws for malformed input: a frame that fails to parse reports `error`.
 */
export function decodeProtobuf(
  buf: Buffer,
  options: ProtobufDecodeOptions = {}
): ProtobufDecodeResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const framed = options.grpcWeb === false ? null : splitGrpcFrames(buf)

  const decodeOne = (body: Buffer, flag?: number): ProtobufFrame => {
    const frame: ProtobufFrame = { byteLength: body.length }
    if (flag !== undefined) frame.flag = flag
    if (flag === 1) {
      frame.trailer = true
      frame.trailerText = body.toString('utf8')
      return frame
    }
    try {
      frame.fields = decodeMessage(body, 0, maxDepth)
    } catch (e) {
      frame.error = e instanceof Error ? e.message : String(e)
    }
    return frame
  }

  if (framed) {
    return {
      grpcWeb: true,
      byteLength: buf.length,
      frames: framed.map((f) => decodeOne(f.body, f.flag))
    }
  }
  if (options.grpcWeb === true) {
    return {
      grpcWeb: false,
      byteLength: buf.length,
      frames: [
        {
          byteLength: buf.length,
          error: 'not a valid sequence of gRPC frames (1-byte flag + 4-byte big-endian length)'
        }
      ]
    }
  }
  return { grpcWeb: false, byteLength: buf.length, frames: [decodeOne(buf)] }
}
