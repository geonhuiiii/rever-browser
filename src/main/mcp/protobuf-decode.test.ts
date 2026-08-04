import { describe, it, expect } from 'vitest'

import { decodeProtobuf, splitGrpcFrames } from './protobuf-decode'

// Wire bytes are hand-built here so the expectations are schema-free by construction.
function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  do {
    let b = v & 0x7f
    v = Math.floor(v / 128)
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return out
}

function tag(field: number, wire: number): number[] {
  return varint(field * 8 + wire)
}

function lenDelim(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...varint(payload.length), ...payload]
}

function grpcFrame(flag: number, payload: number[]): number[] {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(payload.length, 0)
  return [flag, ...len, ...payload]
}

const utf8 = (s: string): number[] => Array.from(Buffer.from(s, 'utf8'))

describe('decodeProtobuf', () => {
  describe('wire types', () => {
    it('recovers a varint field number and value', () => {
      const buf = Buffer.from([...tag(1, 0), ...varint(150)])
      const { grpcWeb, frames } = decodeProtobuf(buf)
      expect(grpcWeb).toBe(false)
      expect(frames).toHaveLength(1)
      expect(frames[0].fields).toEqual({
        '#1': { kind: 'varint', value: 150, signed: 75 }
      })
    })

    it('surfaces the zigzag-decoded signed reading of a varint', () => {
      const buf = Buffer.from([...tag(1, 0), ...varint(3)])
      expect(decodeProtobuf(buf).frames[0].fields?.['#1']).toEqual({
        kind: 'varint',
        value: 3,
        signed: -2
      })
    })

    it('renders varints beyond MAX_SAFE_INTEGER as strings', () => {
      // 2^63 - 1
      const buf = Buffer.from([
        ...tag(1, 0),
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0x7f
      ])
      expect(decodeProtobuf(buf).frames[0].fields?.['#1']).toMatchObject({
        kind: 'varint',
        value: '9223372036854775807'
      })
    })

    it('reads a length-delimited field as a string when it is printable text', () => {
      const buf = Buffer.from(lenDelim(2, utf8('testing')))
      expect(decodeProtobuf(buf).frames[0].fields).toEqual({
        '#2': { kind: 'string', value: 'testing' }
      })
    })

    it('recurses into a nested message', () => {
      const nested = [...tag(1, 0), ...varint(42)]
      const buf = Buffer.from(lenDelim(3, nested))
      expect(decodeProtobuf(buf).frames[0].fields).toEqual({
        '#3': {
          kind: 'message',
          fields: { '#1': { kind: 'varint', value: 42, signed: 21 } }
        }
      })
    })

    it('falls back to base64/hex bytes when a chunk is neither message nor text', () => {
      const buf = Buffer.from(lenDelim(7, [0x00, 0xff]))
      expect(decodeProtobuf(buf).frames[0].fields?.['#7']).toEqual({
        kind: 'bytes',
        base64: Buffer.from([0x00, 0xff]).toString('base64'),
        hex: '00ff',
        length: 2
      })
    })

    it('shows fixed32 as uint32/float and fixed64 as uint64/double', () => {
      const f32 = Buffer.alloc(4)
      f32.writeFloatLE(1.5, 0)
      const f64 = Buffer.alloc(8)
      f64.writeDoubleLE(2.5, 0)
      const buf = Buffer.from([...tag(5, 5), ...Array.from(f32), ...tag(6, 1), ...Array.from(f64)])
      const fields = decodeProtobuf(buf).frames[0].fields!
      expect(fields['#5']).toMatchObject({ kind: 'fixed32', uint32: f32.readUInt32LE(0), float: 1.5 })
      expect(fields['#6']).toMatchObject({ kind: 'fixed64', double: 2.5 })
    })

    it('collects a repeated field number into a list', () => {
      const buf = Buffer.from([...tag(4, 0), ...varint(1), ...tag(4, 0), ...varint(2)])
      expect(decodeProtobuf(buf).frames[0].fields?.['#4']).toEqual([
        { kind: 'varint', value: 1, signed: -1 },
        { kind: 'varint', value: 2, signed: 1 }
      ])
    })

    it('decodes a message mixing varint, string, nested and repeated fields', () => {
      const buf = Buffer.from([
        ...tag(1, 0),
        ...varint(150),
        ...lenDelim(2, utf8('hello')),
        ...lenDelim(3, [...tag(1, 0), ...varint(7)]),
        ...tag(4, 0),
        ...varint(1),
        ...tag(4, 0),
        ...varint(2)
      ])
      const fields = decodeProtobuf(buf).frames[0].fields!
      expect(Object.keys(fields)).toEqual(['#1', '#2', '#3', '#4'])
      expect(fields['#1']).toMatchObject({ value: 150 })
      expect(fields['#2']).toEqual({ kind: 'string', value: 'hello' })
      expect(fields['#3']).toEqual({
        kind: 'message',
        fields: { '#1': { kind: 'varint', value: 7, signed: -4 } }
      })
      expect(fields['#4']).toHaveLength(2)
    })
  })

  describe('gRPC-web framing', () => {
    const dataFrame = grpcFrame(0, [...tag(1, 0), ...varint(150)])
    const trailerFrame = grpcFrame(1, utf8('grpc-status:0\r\n'))

    it('strips frame headers and decodes every frame', () => {
      const res = decodeProtobuf(Buffer.from([...dataFrame, ...trailerFrame]))
      expect(res.grpcWeb).toBe(true)
      expect(res.frames).toHaveLength(2)
      expect(res.frames[0]).toMatchObject({ flag: 0 })
      expect(res.frames[0].fields).toEqual({
        '#1': { kind: 'varint', value: 150, signed: 75 }
      })
      expect(res.frames[1]).toMatchObject({
        flag: 1,
        trailer: true,
        trailerText: 'grpc-status:0\r\n'
      })
    })

    it('decodes a base64 (gRPC-web-text) payload identically', () => {
      const b64 = Buffer.from([...dataFrame, ...trailerFrame]).toString('base64')
      const res = decodeProtobuf(Buffer.from(b64, 'base64'))
      expect(res.grpcWeb).toBe(true)
      expect(res.frames[0].fields?.['#1']).toMatchObject({ value: 150 })
    })

    it('leaves framing in place when grpcWeb is explicitly false', () => {
      const res = decodeProtobuf(Buffer.from(dataFrame), { grpcWeb: false })
      expect(res.grpcWeb).toBe(false)
      // the leading flag byte reads as field 0, which is invalid protobuf
      expect(res.frames[0].error).toMatch(/zero field number/)
    })

    it('reports an error when grpcWeb is forced but the bytes are not framed', () => {
      const res = decodeProtobuf(Buffer.from([...tag(1, 0), ...varint(150)]), { grpcWeb: true })
      expect(res.grpcWeb).toBe(false)
      expect(res.frames[0].error).toMatch(/gRPC frames/)
    })

    it('returns null from splitGrpcFrames for a bare protobuf message', () => {
      expect(splitGrpcFrames(Buffer.from([...tag(1, 0), ...varint(150)]))).toBeNull()
    })
  })

  describe('malformed input', () => {
    it('reports a truncated varint instead of throwing', () => {
      const res = decodeProtobuf(Buffer.from([...tag(1, 0), 0x96]))
      expect(res.frames[0].error).toMatch(/truncated varint/)
    })

    it('reports unsupported group wire types', () => {
      const res = decodeProtobuf(Buffer.from(tag(1, 3)))
      expect(res.frames[0].error).toMatch(/unsupported wire type 3/)
    })

    it('treats empty input as a message with no fields', () => {
      expect(decodeProtobuf(Buffer.alloc(0))).toEqual({
        grpcWeb: false,
        byteLength: 0,
        frames: [{ byteLength: 0, fields: {} }]
      })
    })
  })
})
