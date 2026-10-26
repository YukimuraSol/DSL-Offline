import type { InstallProgress } from '../types'

export function isInstallProgressActive(progress: InstallProgress | null): progress is InstallProgress {
  return progress != null && progress.phase !== 'complete' && progress.phase !== 'error'
}

export function finalizeInstallProgress(
  progress: InstallProgress | null,
  repository: string,
  succeeded: boolean,
  failureMessage: string,
): InstallProgress | null {
  if (progress?.repository !== repository) return progress
  if (succeeded) return null
  return { ...progress, phase: 'error', message: failureMessage, indeterminate: false }
}
