/**
 * 列表面板 —— 文章、书、章节共用的一张表。
 *
 * v2 把卡片网格换成三列表之后，文章库 / 书架 / 目录三处会各写一遍同样的
 * grid + 覆盖层按钮，改一处忘两处。所以行的骨架只在这里实现一次，
 * 三个调用方只决定每一列放什么。
 *
 * ⚠️ 行不能做成 <button>：状态列里还有去复盘 / 去目录的链接，
 * HTML 不允许 button 里嵌可交互元素。所以只有标题是按钮，
 * 用 ::after 把它的点击区撑满整行（见 index.css 的 .list-row__open）。
 */

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ArticleSummaryDto } from '../api/client'

export function ListPanel({
  columns,
  children,
}: {
  /** 表头三列的名字。只是说明，aria-hidden —— 真正的语义在每一行自己身上 */
  columns: [string, string, string]
  children: ReactNode
}) {
  return (
    <div className="list-panel">
      <div className="list-head" aria-hidden="true">
        {columns.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <ul className="list-rows">{children}</ul>
    </div>
  )
}

export function ListRow({
  title,
  sub,
  meta,
  state,
  onOpen,
  disabled,
  tone,
}: {
  title: ReactNode
  sub?: ReactNode
  meta: ReactNode
  /** 第三列。整块传进来 —— 各处状态的含义不一样，不该在这里 switch */
  state: ReactNode
  onOpen: () => void
  disabled?: boolean
  /** 'reading' 给整行铺一层灯光，'read' 把标题压暗一档 */
  tone?: 'reading' | 'read' | null
}) {
  return (
    <li className={`list-row${tone ? ` is-${tone}` : ''}`}>
      <span className="list-row__main">
        <button className="list-row__open" type="button" disabled={disabled} onClick={onOpen}>
          {title}
        </button>
        {sub && <span className="list-row__sub">{sub}</span>}
      </span>
      <span className="list-row__len">{meta}</span>
      {state}
    </li>
  )
}

/**
 * 文章和章节的状态列。两者都是 ArticleSummaryDto 的形状（ChapterSummaryDto 继承它），
 * 状态口径也一样，所以共用这一个 —— 三种互斥状态按 在读 > 读过 > 未读 的顺序判。
 */
export function MarkedRowState({ item }: { item: ArticleSummaryDto }) {
  if (item.resumeSessionId !== null) {
    return (
      <span className="list-row__state is-reading">
        <span className="lamp lamp--sm" aria-hidden="true" />
        在读
      </span>
    )
  }
  if (item.isRead) {
    return (
      <span className="list-row__state">
        读过
        {item.lastMarksSessionId !== null && (
          // 读过的那一行最该点的就是「上次标了什么」。
          // .list-row__marks 有 position: relative，压在整行覆盖层之上才点得到。
          <Link className="list-row__marks" to={`/review/${item.lastMarksSessionId}`}>
            标了 {item.lastMarksCount} 处 →
          </Link>
        )}
      </span>
    )
  }
  return <span className="list-row__state is-unread">未读</span>
}
