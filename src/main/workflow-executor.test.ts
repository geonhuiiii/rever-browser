import { describe, it, expect } from 'vitest'

import { stripFences, substitute } from './workflow-executor'

describe('substitute', () => {
  it('빈 문자열이 아니라 원본 플레이스홀더를 남긴다 (미해결 변수)', () => {
    expect(substitute({ q: 'hello {{missing}}' }, {})).toEqual({ q: 'hello {{missing}}' })
  })

  it('문자열 전체가 플레이스홀더면 값의 타입을 보존한다', () => {
    expect(substitute({ limit: '{{n}}' }, { n: 5 })).toEqual({ limit: 5 })
    expect(substitute({ item: '{{obj}}' }, { obj: { a: 1 } })).toEqual({ item: { a: 1 } })
  })

  it('문자열 중간에 있으면 문자열로 보간한다', () => {
    expect(substitute({ q: 'search: {{term}}!' }, { term: 'shoes' })).toEqual({
      q: 'search: shoes!'
    })
  })

  it('점 표기로 중첩 필드를 읽는다', () => {
    const vars = { ai: { title: 'Acme', tags: ['a', 'b'] } }
    expect(substitute({ t: '{{ai.title}}' }, vars)).toEqual({ t: 'Acme' })
    expect(substitute({ t: '{{ai.tags.1}}' }, vars)).toEqual({ t: 'b' })
  })

  it('객체를 문자열에 보간하면 JSON으로 직렬화한다', () => {
    expect(substitute({ body: 'payload={{obj}}' }, { obj: { a: 1 } })).toEqual({
      body: 'payload={"a":1}'
    })
  })

  it('배열과 중첩 객체를 재귀적으로 처리한다', () => {
    const out = substitute({ list: ['{{a}}', { deep: '{{a}}' }] }, { a: 'x' })
    expect(out).toEqual({ list: ['x', { deep: 'x' }] })
  })

  it('문자열이 아닌 값은 그대로 둔다', () => {
    expect(substitute({ n: 1, b: true, z: null }, {})).toEqual({ n: 1, b: true, z: null })
  })
})

describe('stripFences', () => {
  it('```json 펜스를 벗겨낸다', () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('언어 표기 없는 펜스도 벗겨낸다', () => {
    expect(stripFences('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('펜스가 없으면 트림만 한다', () => {
    expect(stripFences('  {"a":1}  ')).toBe('{"a":1}')
  })
})
