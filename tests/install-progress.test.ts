import { describe, expect, it } from 'vitest'
import { finalizeInstallProgress, isInstallProgressActive } from '../src/lib/install-progress'
import type { InstallProgress } from '../src/types'

function progress(phase: InstallProgress['phase']): InstallProgress {
  return {
    repository: 'demo/plugin',
    kind: 'plugin',
    phase,
    percent: 50,
    message: phase,
  }
}

describe('install progress lifecycle', () => {
  it('restores every in-flight phase after a view remount', () => {
    for (const phase of ['preparing', 'resolving', 'downloading', 'building', 'configuring', 'verifying'] as const) {
      expect(isInstallProgressActive(progress(phase))).toBe(true)
    }
  })

  it('does not restore completed, failed, or absent tasks', () => {
    expect(isInstallProgressActive(progress('complete'))).toBe(false)
    expect(isInstallProgressActive(progress('error'))).toBe(false)
    expect(isInstallProgressActive(null)).toBe(false)
  })

  it('clears successful tasks but preserves a visible failure for retry', () => {
    expect(finalizeInstallProgress(progress('downloading'), 'demo/plugin', true, '')).toBeNull()
    expect(finalizeInstallProgress(progress('downloading'), 'demo/plugin', false, '下载失败')).toEqual({
      ...progress('downloading'),
      phase: 'error',
      message: '下载失败',
      indeterminate: false,
    })
  })

  it('does not finish a different repository task', () => {
    const current = progress('verifying')
    expect(finalizeInstallProgress(current, 'other/plugin', false, '失败')).toBe(current)
  })
})
