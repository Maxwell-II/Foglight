import { useMemo } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { guestReadingStore, serverReadingStore, type ReadingStore } from '../lib/readingStore'

export type ReadingMode = 'server' | 'guest'

/**
 * 按路由挑存储实现：
 *   /read/:sessionId、/review/:sessionId          → 服务端（?run= 是书的阅读批次）
 *   /try/:articleId、/try/:articleId/review       → 本地（游客只读散篇，没有 run）
 *
 * 同一个 mode 下换了 id 时返回新实例；页面拿 store 当 effect 的依赖，据此重载。
 */
export function useReadingStore(mode: ReadingMode): { store: ReadingStore; bookRunId?: number } {
  const { sessionId, articleId } = useParams<{ sessionId?: string; articleId?: string }>()
  const [searchParams] = useSearchParams()
  const bookRunId = mode === 'server' ? Number(searchParams.get('run')) || undefined : undefined

  const store = useMemo(
    () =>
      mode === 'server'
        ? serverReadingStore(Number(sessionId), bookRunId)
        : guestReadingStore(Number(articleId)),
    [mode, sessionId, articleId, bookRunId],
  )

  return { store, bookRunId }
}
