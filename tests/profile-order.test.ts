import { describe, expect, it } from 'vitest'
import { activeOrderFromDisplay, movePackage, movePackageTo, reorderProfilePlugins } from '../src/lib/profile-order'
import type { ManagedPlugin, ProfileState } from '../src/types'

function plugin(packageName: string, enabled: boolean, order: number | null): ManagedPlugin {
  return {
    packageName,
    displayName: packageName,
    version: '1.0.0',
    description: '',
    enabled,
    builtin: false,
    locked: false,
    compatible: true,
    order,
  }
}

const profile: ProfileState = {
  initialized: true,
  profileDir: '/home/tester/.dsh/profiles/web',
  manifestPath: '/home/tester/.dsh/profiles/web/package.json',
  activeBundles: ['a', 'b', 'c'],
  dependencyCount: 3,
  disabledCount: 1,
  plugins: [plugin('a', true, 1), plugin('b', true, 2), plugin('c', true, 3), plugin('z', false, null)],
}

describe('reorderProfilePlugins', () => {
  it('renumbers the enabled plugins to match the new order', () => {
    const next = reorderProfilePlugins(profile, ['c', 'a', 'b'])
    expect(next.activeBundles).toEqual(['c', 'a', 'b'])
    expect(next.plugins.filter(p => p.enabled).map(p => [p.packageName, p.order])).toEqual([
      ['c', 1], ['a', 2], ['b', 3],
    ])
  })

  it('keeps disabled plugins last and unnumbered', () => {
    const next = reorderProfilePlugins(profile, ['c', 'a', 'b'])
    expect(next.plugins.at(-1)).toMatchObject({ packageName: 'z', enabled: false, order: null })
  })

  it('does not mutate the input profile', () => {
    reorderProfilePlugins(profile, ['c', 'a', 'b'])
    expect(profile.activeBundles).toEqual(['a', 'b', 'c'])
    expect(profile.plugins[0].order).toBe(1)
  })
})

describe('activeOrderFromDisplay', () => {
  it('restores a re-enabled plugin to its retained display position', () => {
    expect(activeOrderFromDisplay(['a', 'b', 'c', 'd'], ['a', 'b', 'd', 'c'])).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does not mutate either input array', () => {
    const displayOrder = ['a', 'b', 'c', 'd']
    const activePackageNames = ['a', 'b', 'd', 'c']
    activeOrderFromDisplay(displayOrder, activePackageNames)
    expect(displayOrder).toEqual(['a', 'b', 'c', 'd'])
    expect(activePackageNames).toEqual(['a', 'b', 'd', 'c'])
  })
})

describe('movePackage', () => {
  it('swaps with the previous entry', () => {
    expect(movePackage(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
  })

  it('swaps with the next entry', () => {
    expect(movePackage(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
  })

  it('returns null at the boundaries', () => {
    expect(movePackage(['a', 'b'], 'a', -1)).toBeNull()
    expect(movePackage(['a', 'b'], 'b', 1)).toBeNull()
  })

  it('returns null for an unknown package', () => {
    expect(movePackage(['a', 'b'], 'missing', 1)).toBeNull()
  })

  it('does not mutate the input array', () => {
    const names = ['a', 'b', 'c']
    movePackage(names, 'b', 1)
    expect(names).toEqual(['a', 'b', 'c'])
  })
})

describe('movePackageTo', () => {
  it('moves an entry forward to the target position', () => {
    expect(movePackageTo(['a', 'b', 'c', 'd'], 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves an entry backward to the target position', () => {
    expect(movePackageTo(['a', 'b', 'c', 'd'], 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('returns null when dropped on itself', () => {
    expect(movePackageTo(['a', 'b'], 'a', 'a')).toBeNull()
  })

  it('returns null when either package is unknown', () => {
    expect(movePackageTo(['a', 'b'], 'missing', 'a')).toBeNull()
    expect(movePackageTo(['a', 'b'], 'a', 'missing')).toBeNull()
  })

  it('does not mutate the input array', () => {
    const names = ['a', 'b', 'c']
    movePackageTo(names, 'a', 'c')
    expect(names).toEqual(['a', 'b', 'c'])
  })
})
