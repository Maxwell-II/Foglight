import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
  ApiError,
  createReviewBatch,
  getReviewBatch,
  getReviewCandidates,
  handleReviewBatch,
  type ReviewBatchDto,
  type ReviewCandidatesDto,
} from '../api/client'

const requestKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

export default function BookReviewPage() {
  const { bookId: value } = useParams<{ bookId: string }>()
  const bookId = Number(value)
  const [search] = useSearchParams()
  const runId = Number(search.get('run')) || undefined
  const batchId = Number(search.get('batch')) || undefined
  const [candidates, setCandidates] = useState<ReviewCandidatesDto | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [batch, setBatch] = useState<ReviewBatchDto | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const requestRef = useRef({ signature: '', key: requestKey() })

  useEffect(() => {
    if (batchId) {
      getReviewBatch(bookId, batchId).then(setBatch).catch((err) => setError(String(err)))
      return
    }
    getReviewCandidates(bookId, runId)
      .then((result) => {
        setCandidates(result)
        setSelected(new Set(result.pages.flatMap((page) => page.currentMarks.map((mark) => mark.id))))
      })
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : '加载待回顾内容失败'))
  }, [bookId, runId, batchId])

  const pageByMark = useMemo(() => {
    const result = new Map<number, number>()
    for (const page of candidates?.pages ?? []) {
      for (const mark of [...page.currentMarks, ...page.earlierMarks]) result.set(mark.id, page.pageNumber)
    }
    return result
  }, [candidates])

  const toggle = (ids: number[], checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      for (const id of ids) checked ? next.add(id) : next.delete(id)
      return next
    })
  }

  const applyRange = () => {
    const start = Number(from)
    const end = Number(to)
    if (!from || !to || !Number.isInteger(start) || !Number.isInteger(end) || start < 1 || start > end) {
      setError('页码范围必须完整填写，并且起始页不能大于结束页。')
      return
    }
    const ids = [...pageByMark.entries()]
      .filter(([, page]) => page >= start && page <= end)
      .map(([id]) => id)
    if (!ids.length) {
      setError('这个范围里没有待回顾标记。')
      return
    }
    setError(null)
    setSelected(new Set(ids))
  }

  const generate = async () => {
    if (!selected.size) {
      setError('请至少选择一处标记。')
      return
    }
    setBusy(true)
    setError(null)
    const signature = [...selected].sort((a, b) => a - b).join(',')
    if (requestRef.current.signature !== signature) {
      requestRef.current = { signature, key: requestKey() }
    }
    try {
      setBatch(
        await createReviewBatch(bookId, {
          ...(runId ? { runId } : {}),
          markIds: [...selected],
          requestKey: requestRef.current.key,
        }),
      )
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '生成失败，请刷新选择后重试。')
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!batch) return
    try {
      await navigator.clipboard.writeText(batch.markdown)
      setCopied(true)
    } catch {
      setError('复制失败，回顾批次仍然保留，可以重试。')
    }
  }

  const handle = async () => {
    if (!batch) return
    setBusy(true)
    try {
      const result = await handleReviewBatch(bookId, batch.id)
      setBatch({ ...batch, handledAt: result.handledAt })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '更新处理状态失败，请重试。')
    } finally {
      setBusy(false)
    }
  }

  if (batch) {
    return (
      <div className="wrap">
        <Link className="back-link" to={`/books/${bookId}`}>← 返回目录</Link>
        <h1 className="title">回顾批次</h1>
        <p className="dim">第 {batch.pageNumbers.join('、')} 页 · {batch.markCount} 处标记</p>
        {error && <p className="error-banner">{error}</p>}
        <textarea className="export" readOnly value={batch.markdown} onFocus={(event) => event.target.select()} />
        <div className="book-fixed-actions">
          <button className="btn-primary" onClick={() => void copy()}>{copied ? '已复制' : '复制到剪贴板'}</button>
          <button className="btn-secondary" disabled={busy || batch.handledAt !== null} onClick={() => void handle()}>
            {batch.handledAt ? '本批已处理' : '标记本批已处理'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="wrap">
      <Link className="back-link" to={`/books/${bookId}`}>← 返回目录</Link>
      <h1 className="title">选择待回顾内容</h1>
      <p className="dim">默认只选择本次新增标记。以前留下的内容由你决定是否一起处理。</p>
      {error && <p className="error-banner">{error}</p>}
      {!candidates && !error && <p className="dim">加载中…</p>}
      {candidates?.openBatches.length ? (
        <section className="review-open-batches">
          <h2>尚未确认处理的导出</h2>
          {candidates.openBatches.map((item) => (
            <Link key={item.id} to={`/books/${bookId}/review?batch=${item.id}`}>
              第 {item.pageNumbers.join('、')} 页 · {item.markCount} 处 →
            </Link>
          ))}
        </section>
      ) : null}
      {candidates && candidates.pages.length === 0 && <p className="dim">没有待回顾标记。</p>}
      {candidates?.pages.map((page) => {
        const currentIds = page.currentMarks.map((mark) => mark.id)
        const earlierIds = page.earlierMarks.map((mark) => mark.id)
        return (
          <section className="review-page-choice" key={page.articleId}>
            <h2>第 {page.pageNumber} 页 · {page.sectionTitle}</h2>
            {currentIds.length > 0 && (
              <label>
                <input
                  type="checkbox"
                  checked={currentIds.every((id) => selected.has(id))}
                  onChange={(event) => toggle(currentIds, event.target.checked)}
                /> 本次新增 {currentIds.length} 处
              </label>
            )}
            {earlierIds.length > 0 && (
              <label>
                <input
                  type="checkbox"
                  checked={earlierIds.every((id) => selected.has(id))}
                  onChange={(event) => toggle(earlierIds, event.target.checked)}
                /> 以前待回顾 {earlierIds.length} 处
              </label>
            )}
          </section>
        )
      })}
      {candidates && candidates.pages.length > 0 && (
        <>
          <div className="book-export__range">
            <label className="field">从第<input type="number" min="1" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label className="field">到第<input type="number" min="1" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <button className="btn-secondary" onClick={applyRange}>只选这个范围</button>
          </div>
          <button className="btn-primary" disabled={busy || selected.size === 0} onClick={() => void generate()}>
            {busy ? '生成中…' : `生成回顾素材（${selected.size} 处）`}
          </button>
        </>
      )}
    </div>
  )
}
