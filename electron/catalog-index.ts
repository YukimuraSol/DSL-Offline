import { DOMImplementation, DOMParser, XMLSerializer } from '@xmldom/xmldom'
import type { CatalogComponentKind, CatalogIndexEntry, CatalogIndexTag, CatalogRepositoryAnalysis } from '../src/types'

export const CATALOG_INDEX_SCHEMA = '1'
export const CATALOG_INDEX_PATH = 'catalog/index.xml'

const TAG_ORDER: CatalogIndexTag[] = ['plugin', 'skill', 'runtime', 'preset', 'dsh', 'invalid']
const TAG_SET = new Set<CatalogIndexTag>(TAG_ORDER)

function repositoryName(repository: string): string {
  return repository.split('/').at(-1) ?? repository
}

export function catalogEntryOrder(left: CatalogIndexEntry, right: CatalogIndexEntry): number {
  const byName = repositoryName(left.repository).localeCompare(repositoryName(right.repository), 'en', { sensitivity: 'base' })
  return byName || left.repository.localeCompare(right.repository, 'en', { sensitivity: 'base' })
}

function normalizeTags(tags: Iterable<CatalogIndexTag>): CatalogIndexTag[] {
  const unique = new Set(tags)
  return TAG_ORDER.filter(tag => unique.has(tag))
}

export function catalogTagsFromAnalysis(analysis: CatalogRepositoryAnalysis): CatalogIndexTag[] {
  if (analysis.kind === 'dsh') return ['dsh']
  if (analysis.kind === 'invalid') return ['invalid']
  const tags = analysis.componentKinds.map<CatalogIndexTag>(kind => kind === 'application' ? 'runtime' : kind)
  return normalizeTags(tags)
}

export function catalogComponentKindsFromTags(tags: CatalogIndexTag[]): CatalogComponentKind[] {
  const kinds: CatalogComponentKind[] = []
  if (tags.includes('plugin')) kinds.push('plugin')
  if (tags.includes('skill')) kinds.push('skill')
  if (tags.includes('runtime')) kinds.push('application')
  if (tags.includes('preset')) kinds.push('preset')
  return kinds
}

export function serializeCatalogIndex(entries: CatalogIndexEntry[]): string {
  const implementation = new DOMImplementation()
  const document = implementation.createDocument(null, 'dsh-catalog', null)
  const root = document.documentElement
  root.setAttribute('schema', CATALOG_INDEX_SCHEMA)
  for (const entry of [...entries].sort(catalogEntryOrder)) {
    const element = document.createElement('repository')
    element.setAttribute('name', entry.repository)
    element.setAttribute('branch', entry.defaultBranch)
    if (entry.repositoryUpdatedAt) element.setAttribute('updated', entry.repositoryUpdatedAt)
    element.setAttribute('tags', normalizeTags(entry.tags).join(','))
    root.appendChild(element)
  }
  const serializer = new XMLSerializer()
  const rows = Array.from({ length: root.childNodes.length }, (_, index) =>
    `  ${serializer.serializeToString(root.childNodes.item(index)!)}`)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<dsh-catalog schema="${CATALOG_INDEX_SCHEMA}">`,
    ...rows,
    '</dsh-catalog>',
    '',
  ].join('\n')
}

export function parseCatalogIndex(xml: string): CatalogIndexEntry[] {
  const parseErrors: string[] = []
  const document = new DOMParser({
    errorHandler: {
      warning: () => undefined,
      error: message => parseErrors.push(message),
      fatalError: message => parseErrors.push(message),
    },
  }).parseFromString(xml, 'application/xml')
  const root = document.documentElement
  if (parseErrors.length > 0 || root?.tagName !== 'dsh-catalog' || root.getAttribute('schema') !== CATALOG_INDEX_SCHEMA) {
    throw new Error('共享检测索引不是受支持的 XML 格式。')
  }
  const entries = new Map<string, CatalogIndexEntry>()
  for (const element of Array.from(root.getElementsByTagName('repository'))) {
    const repository = element.getAttribute('name')?.trim() ?? ''
    const defaultBranch = element.getAttribute('branch')?.trim() ?? ''
    const repositoryUpdatedAt = element.getAttribute('updated')?.trim() || null
    const tags = normalizeTags((element.getAttribute('tags') ?? '').split(',')
      .map(tag => tag.trim())
      .filter((tag): tag is CatalogIndexTag => TAG_SET.has(tag as CatalogIndexTag)))
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !defaultBranch || tags.length === 0) continue
    entries.set(repository.toLowerCase(), { repository, defaultBranch, repositoryUpdatedAt, tags })
  }
  return [...entries.values()].sort(catalogEntryOrder)
}
