/**
 * 列表分页（纯前端切片）。
 *
 * 为什么不做成后端分页：列表接口只返回摘要（不含正文），几百篇也就几十 KB，
 * 侧栏和篇幅计数本来就要拿全量。慢的从来不是数据，是一口气渲染几百行、页面长到滑不到底。
 *
 * 页码记在 sessionStorage（按 storageKey 分开）而不是只放 state：
 * 点进一篇读完再点「返回」，要回到刚才那一页，而不是被甩回第 1 页重新翻。
 * 换了筛选条件（resetKey 变了）才回到第 1 页。
 */

import { useCallback, useEffect, useRef, useState } from 'react'

export const PAGE_SIZE = 20

function readStoredPage(key: string): number {
  try {
    const n = Number(sessionStorage.getItem(key))
    return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1
  } catch {
    return 1
  }
}

function writeStoredPage(key: string, page: number) {
  try {
    sessionStorage.setItem(key, String(page))
  } catch {
    // 存不进去只是回不到原页，不影响翻页本身
  }
}

export interface Paged<T> {
  page: number
  pageCount: number
  total: number
  pageSize: number
  /** 当前页的条目；列表还没加载时为 null */
  items: T[] | null
  setPage: (page: number) => void
}

export function usePagination<T>(
  all: T[] | null,
  { storageKey, resetKey, pageSize = PAGE_SIZE }: { storageKey: string; resetKey?: unknown; pageSize?: number },
): Paged<T> {
  const [rawPage, setRawPage] = useState(() => readStoredPage(storageKey))

  const setPage = useCallback(
    (next: number) => {
      setRawPage(next)
      writeStoredPage(storageKey, next)
    },
    [storageKey],
  )

  // 首次渲染不重置（那会把刚从 sessionStorage 读回来的页码冲掉），只在筛选真的变了时回第 1 页
  const lastReset = useRef(resetKey)
  useEffect(() => {
    if (Object.is(lastReset.current, resetKey)) return
    lastReset.current = resetKey
    setPage(1)
  }, [resetKey, setPage])

  const total = all?.length ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  // 存下来的页码可能已经越界（文章被撤下、换了筛选），渲染时夹住，不去改存储
  const page = all ? Math.min(Math.max(1, rawPage), pageCount) : 1
  const items = all ? all.slice((page - 1) * pageSize, page * pageSize) : null

  return { page, pageCount, total, pageSize, items, setPage }
}
