import { describe, expect, it } from 'vitest'
import { errorText, formatBytes, formatRelativeTime, formatStars, pluginInitial } from '../src/lib/format'
import type { ManagedPlugin } from '../src/types'

const plugin = (displayName: string): ManagedPlugin => ({
  packageName: '@scope/dsh-example',
  displayName,
  version: '1.0.0',
  description: '',
  enabled: true,
  builtin: false,
  locked: false,
  compatible: true,
  order: 1,
})

describe('formatStars', () => {
  it('shows counts under a thousand verbatim', () => {
    expect(formatStars(0)).toBe('0')
    expect(formatStars(999)).toBe('999')
  })

  it('abbreviates thousands with one decimal', () => {
    expect(formatStars(1000)).toBe('1.0k')
    expect(formatStars(1234)).toBe('1.2k')
    expect(formatStars(45678)).toBe('45.7k')
  })
})

describe('formatBytes', () => {
  it('formats downloaded byte counts compactly', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(75_475_520)).toBe('72.0 MB')
    expect(formatBytes(1_746.29 * 1024 ** 2)).toBe('1.71 GB')
  })
})

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-08-14T12:00:00Z')

  it('never reports less than a minute', () => {
    expect(formatRelativeTime('2026-08-14T11:59:59Z', now)).toBe('1 分钟前')
  })

  it('reports minutes below an hour', () => {
    expect(formatRelativeTime('2026-08-14T11:15:00Z', now)).toBe('45 分钟前')
  })

  it('reports hours below a day', () => {
    expect(formatRelativeTime('2026-08-14T02:00:00Z', now)).toBe('10 小时前')
  })

  it('reports days below a month', () => {
    expect(formatRelativeTime('2026-08-04T12:00:00Z', now)).toBe('10 天前')
  })

  it('falls back to a calendar date beyond thirty days', () => {
    expect(formatRelativeTime('2026-01-04T12:00:00Z', now)).not.toMatch(/前$/)
  })
})

describe('pluginInitial', () => {
  it('takes the first two characters in upper case', () => {
    expect(pluginInitial(plugin('memory bank'))).toBe('ME')
  })

  it('ignores surrounding whitespace', () => {
    expect(pluginInitial(plugin('  ab  '))).toBe('AB')
  })

  it('handles a single character name', () => {
    expect(pluginInitial(plugin('x'))).toBe('X')
  })
})

describe('errorText', () => {
  it('uses the message of an Error', () => {
    expect(errorText(new Error('boom'))).toBe('boom')
  })

  it('stringifies anything else', () => {
    expect(errorText('plain string')).toBe('plain string')
    expect(errorText(404)).toBe('404')
    expect(errorText(null)).toBe('null')
  })
})
