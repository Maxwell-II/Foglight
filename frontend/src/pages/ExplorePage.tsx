/**
 * 公开文章 `/explore`（公开）：游客版的文章库。
 *
 * 落地页只放一篇首推 + 几篇推荐，全量在这里翻页看 —— 把两百多篇直接铺在落地页上，
 * 页面长到滑不到底，第一屏那篇「现在就能读」反而被淹掉。
 * 篇幅档位和翻页的行为和登录后的 /library 一致（lib/levels.ts、usePagination）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { listPublicArticles, type ArticleSummaryDto } from '../api/client'
import GuestRowState from '../components/GuestRowState'
import { ListPanel, ListRow } from '../components/ListPanel'
import Pagination from '../components/Pagination'
import PublicLayout from '../components/PublicLayout'
import { usePagination } from '../hooks/usePagination'
import { LEVEL_LABELS, LEVEL_ORDER, countLevels, filterLevel, type LevelFilter } from '../lib/levels'

export default function ExplorePage() {
  const navigate = useNavigate()
  const [articles, setArticles] = useState<ArticleSummaryDto[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [level, setLevel] = useState<LevelFilter>('short')

  useEffect(() => {
    let cancelled = false
    listPublicArticles()
      .then((list) => {
        if (!cancelled) setArticles(list)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const counts = useMemo(() => countLevels(articles), [articles])
  // 公开库里没有短文时别停在一个空档位上
  const effectiveLevel: LevelFilter = articles && level === 'short' && counts.short === 0 ? 'all' : level
  const filtered = useMemo(() => filterLevel(articles, effectiveLevel), [articles, effectiveLevel])
  const paged = usePagination(filtered, { storageKey: 'foglight:explorePage', resetKey: effectiveLevel })
  const listTop = useRef<HTMLDivElement>(null)

  return (
    <PublicLayout>
      <header className="page-header explore-header">
        <div className="page-header__text">
          <h1 className="title">公开文章</h1>
          <p className="page-header__sub">英文原文，不用登录就能读。按篇幅挑一篇。</p>
        </div>

        {articles && articles.length > 0 && (
          <div className="segmented" role="group" aria-label="篇幅">
            {LEVEL_ORDER.map((lv) => (
              <button key={lv} type="button" aria-pressed={effectiveLevel === lv} onClick={() => setLevel(lv)}>
                {LEVEL_LABELS[lv]}
                <span className="segmented__count">{counts[lv]}</span>
              </button>
            ))}
          </div>
        )}
      </header>

      {failed && <p className="error-banner">文章加载不出来，稍后刷新再试一次。</p>}
      {!failed && articles === null && <p className="dim">加载中…</p>}

      {articles && articles.length === 0 && (
        <div className="empty-state">
          <span className="lamp" aria-hidden="true" />
          <h2 className="empty-state__title">公开文章还没上架</h2>
          <p className="empty-state__body">第一批可以合法公开的英文原文正在整理。</p>
        </div>
      )}

      {filtered && filtered.length === 0 && articles && articles.length > 0 && (
        <p className="dim">
          这个档位还没有文章。
          <button className="link-button" type="button" onClick={() => setLevel('all')}>
            看全部 {articles.length} 篇
          </button>
        </p>
      )}

      {paged.items && paged.items.length > 0 && (
        <div ref={listTop} className="paged-list">
          <ListPanel columns={['标题', '篇幅', '这台浏览器里']}>
            {paged.items.map((a) => (
              <ListRow
                key={a.id}
                title={a.title}
                sub={a.author ?? '佚名'}
                meta={
                  <>
                    {a.wordCount} 词
                    <span className="list-row__minutes">约 {a.estMinutes} 分钟</span>
                  </>
                }
                state={<GuestRowState articleId={a.id} />}
                onOpen={() => navigate(`/try/${a.id}`)}
              />
            ))}
          </ListPanel>
          <Pagination paged={paged} scrollTo={listTop} />
        </div>
      )}

      <p className="auth-footnote">
        <Link to="/">← 回首页</Link>
      </p>
    </PublicLayout>
  )
}
