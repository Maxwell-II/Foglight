/**
 * 登录 / 注册后的本地标记迁移询问（user-flows §3 路径 2）。
 *
 * ⛔ 绝不自动静默合并：出错时用户看不见，而这类数据丢了人不会再回来。
 * 所以只做一次显式询问，两个出口：
 *   导入 → POST /marks/import，每批最多 50 篇。**哪一批成功，才删哪一批的本地记录**；
 *          某一批失败就停下：已成功的不回滚，剩下的原样留在本地，并说出来
 *   暂不 → 本地原样留着，本标签页内不再问（sessionStorage），下次登录再问
 *
 * 挂在 <RequireAuth> 的 authed 分支里，不挂在 <AppShell>：登录后回跳的地址
 * 可能是壳外面的阅读器，挂在壳里就会漏问。
 */

import { useState, type KeyboardEvent } from 'react'
import { ApiError, MARKS_IMPORT_BATCH, importMarks } from '../api/client'
import {
  dismissGuestImport,
  guestMarkToPayload,
  isGuestImportDismissed,
  listGuestRecords,
  removeGuestRecords,
  type GuestRecord,
} from '../lib/guestStorage'

/** 后端的 {detail} 是中文人话，失败时原样给他看，比一句「失败了」有用 */
function detailOf(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null
  try {
    const detail = (JSON.parse(err.message) as { detail?: unknown }).detail
    return typeof detail === 'string' ? detail : null
  } catch {
    return null
  }
}

/** 只算有标记的：光打开过、滚了两下的文章没什么可迁的，也不该拿来凑数吓人 */
function pendingRecords(): GuestRecord[] {
  if (isGuestImportDismissed()) return []
  // 按 articleId 排：localStorage 的 key 顺序由浏览器决定，排一下分批才是确定的
  return listGuestRecords()
    .filter((r) => r.marks.length > 0)
    .sort((a, b) => a.articleId - b.articleId)
}

interface Totals {
  sessions: number
  marks: number
  /** 已下架、后端跳过的文章数 */
  skipped: number
}

const NO_TOTALS: Totals = { sessions: 0, marks: 0, skipped: 0 }

export default function GuestImportPrompt({ onImported }: { onImported: () => void }) {
  // 挂载时扫一次就定下来，询问期间不跟着 storage 变，免得数字在他眼前跳。
  // 只有分批导入做完一部分时才缩小：标题上的 N / M 始终是「还留在本地的」
  const [records, setRecords] = useState(pendingRecords)
  const [phase, setPhase] = useState<'ask' | 'importing' | 'failed' | 'done' | 'closed'>(
    records.length > 0 ? 'ask' : 'closed',
  )
  // 跨批次、跨重试累计：失败后点「重试」接着导剩下的，最后报的是总数
  const [totals, setTotals] = useState<Totals>(NO_TOTALS)
  const [failure, setFailure] = useState<string | null>(null)

  if (phase === 'closed') return null

  const articleCount = records.length
  const markCount = records.reduce((sum, r) => sum + r.marks.length, 0)

  const doImport = async () => {
    setPhase('importing')
    setFailure(null)
    let sum = totals
    let done = 0
    try {
      // 后端一次最多收 50 篇。每批内部全有或全无，批与批之间互不影响
      for (; done < records.length; done += MARKS_IMPORT_BATCH) {
        const batch = records.slice(done, done + MARKS_IMPORT_BATCH)
        const res = await importMarks({
          sessions: batch.map((r) => ({
            articleId: r.articleId,
            finished: r.status === 'finished',
            marks: r.marks.map(guestMarkToPayload),
          })),
        })
        // 这一批落库了才删这一批。被跳过的（文章已下架）也一起删：
        // 它们再也导不进去，留着只会每次登录都被问一遍
        removeGuestRecords(batch.map((r) => r.articleId))
        sum = {
          sessions: sum.sessions + res.importedSessions,
          marks: sum.marks + res.importedMarks,
          skipped: sum.skipped + (res.skippedArticleIds?.length ?? 0),
        }
      }
      setTotals(sum)
      setRecords([])
      setPhase('done')
    } catch (err) {
      // 停在失败的这一批：前面成功的不回滚，这一批和后面的原样留在本地
      setTotals(sum)
      setRecords(records.slice(done))
      setFailure(detailOf(err))
      setPhase('failed')
    }
    // 只要有一批进了账号，文章库的「读过 / 标了 N 处」就该刷新
    if (sum.sessions > totals.sessions) onImported()
  }

  const later = () => {
    dismissGuestImport()
    setPhase('closed')
  }

  // 可能压在阅读器上面：别让 1 / 2 / F / Esc 穿过弹窗去切笔、甚至「完成阅读」
  const swallowKeys = (e: KeyboardEvent) => e.stopPropagation()

  return (
    <div className="modal-backdrop">
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-import-title"
        onKeyDown={swallowKeys}
      >
        {phase === 'done' ? (
          <>
            <h2 id="guest-import-title" className="modal__title">
              {totals.sessions > 0 ? '导入好了' : '处理完了'}
            </h2>
            <p className="modal__body">
              {totals.sessions > 0
                ? `${totals.sessions} 篇文章、${totals.marks} 条标记已经存进账号。`
                : '没有可以导入的文章。'}
              {totals.skipped > 0 && `${totals.skipped} 篇文章已下架，未导入。`}
              这台浏览器里的本地副本已清掉。
            </p>
            <div className="modal__actions">
              <button className="btn-primary" type="button" autoFocus onClick={() => setPhase('closed')}>
                好
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 id="guest-import-title" className="modal__title">
              检测到本地 {articleCount} 篇文章、{markCount} 条标记，导入到账号？
            </h2>
            <p className="modal__body">
              这是你没登录时在这台浏览器里标的。导入后换设备也能看到；
              选「暂不」的话，它们原样留在这台浏览器里，下次登录还会再问。
            </p>
            {phase === 'failed' && (
              <p className="error-banner" role="alert">
                导入没有全部成功{failure ? `（${failure}）` : ''}。
                {totals.sessions > 0 || totals.skipped > 0
                  ? `已经导入 ${totals.sessions} 篇、${totals.marks} 条标记${
                      totals.skipped > 0 ? `（另有 ${totals.skipped} 篇已下架，未导入）` : ''
                    }；上面这些还留在本地，没有动。`
                  : '本地记录一条都没动。'}
                可以再试一次，或者先放着。
              </p>
            )}
            <div className="modal__actions">
              <button className="btn-secondary" type="button" onClick={later} disabled={phase === 'importing'}>
                暂不
              </button>
              <button
                className="btn-primary"
                type="button"
                autoFocus
                onClick={doImport}
                disabled={phase === 'importing'}
              >
                {phase === 'importing' ? '导入中…' : phase === 'failed' ? '重试导入' : '导入'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
