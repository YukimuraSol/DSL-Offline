import type { CatalogRepositoryAnalysis, CatalogRepositoryResult } from '../types'

export type CatalogBatchOutcome =
  | { repository: CatalogRepositoryResult; status: 'fulfilled'; analysis: CatalogRepositoryAnalysis }
  | { repository: CatalogRepositoryResult; status: 'rejected'; reason: unknown }

/** Start every repository analysis immediately, then report results as each task settles. */
export async function analyzeCatalogPageInParallel(
  repositories: CatalogRepositoryResult[],
  analyze: (repository: CatalogRepositoryResult) => Promise<CatalogRepositoryAnalysis>,
  onSettled: (outcome: CatalogBatchOutcome, completed: number, total: number) => void,
): Promise<CatalogBatchOutcome[]> {
  let completed = 0
  const total = repositories.length
  return Promise.all(repositories.map(async repository => {
    let outcome: CatalogBatchOutcome
    try {
      outcome = { repository, status: 'fulfilled', analysis: await analyze(repository) }
    } catch (reason) {
      outcome = { repository, status: 'rejected', reason }
    }
    completed += 1
    onSettled(outcome, completed, total)
    return outcome
  }))
}
