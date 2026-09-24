/**
 * 列表底部的翻页条：‹ 上一页  1 … 4 5 6 … 13  下一页 ›  　第 81–100 篇，共 249 篇
 *
 * 只有一页时不渲染。翻页后把列表顶部滚回视野（scrollTo 传进来的元素）：
 * 在第 1 页的底部点「下一页」，不该停在第 2 页的底部。
 */

import type { RefObject } from 'react'
import type { Paged } from '../hooks/usePagination'

/** 1 … p-1 p p+1 … last；两端和当前页附近各留一个，中间折叠 */
function pageNumbers(page: number, pageCount: number): (number | 'gap')[] {
  const keep = new Set([1, pageCount, page - 1, page, page + 1])
  const out: (number | 'gap')[] = []
  for (let p = 1; p <= pageCount; p++) {
    if (keep.has(p)) out.push(p)
    else if (out[out.length - 1] !== 'gap') out.push('gap')
  }
  return out
}

export default function Pagination<T>({
  paged,
  unit = '篇',
  scrollTo,
}: {
  paged: Paged<T>
  unit?: string
  scrollTo?: RefObject<HTMLElement | null>
}) {
  const { page, pageCount, total, pageSize, setPage } = paged
  if (pageCount <= 1) return null

  const go = (next: number) => {
    setPage(next)
    scrollTo?.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)

  return (
    <nav className="pager" aria-label="翻页">
      <button type="button" className="pager__step" disabled={page === 1} onClick={() => go(page - 1)}>
        ‹ 上一页
      </button>
      <span className="pager__pages">
        {pageNumbers(page, pageCount).map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} className="pager__gap" aria-hidden="true">
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              className="pager__num"
              aria-current={p === page ? 'page' : undefined}
              aria-label={`第 ${p} 页`}
              onClick={() => go(p)}
            >
              {p}
            </button>
          ),
        )}
      </span>
      {/* 窄屏上页码按钮收起，只剩这一句当位置提示 */}
      <span className="pager__compact" aria-hidden="true">
        {page} / {pageCount}
      </span>
      <button
        type="button"
        className="pager__step"
        disabled={page === pageCount}
        onClick={() => go(page + 1)}
      >
        下一页 ›
      </button>
      <span className="pager__range">
        第 {from}–{to} {unit}，共 {total} {unit}
      </span>
    </nav>
  )
}
