import type { ReactNode } from 'react'

/** 各页面顶部统一的标题区。 */
export function PageHeading({ eyebrow, title, description, actions }: {
  eyebrow: string
  title: string
  description: string
  actions?: ReactNode
}) {
  return (
    <div className="page-heading">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  )
}
