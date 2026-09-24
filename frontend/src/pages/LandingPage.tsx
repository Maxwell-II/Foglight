/**
 * 落地页 `/`（公开）。
 *
 * 第一屏就是一篇立刻能读的短文，不是功能介绍（design-brief §6）：
 * 陌生人要在 30 秒内开始读，CTA 是「读这一篇」而不是「注册」。
 *
 * 必须说清的三句话（user-flows §7，少一句就是骗人）：
 *   1. 不用注册就能完整读一篇
 *   2. 不注册的话，记录只存在这台浏览器里，清了就没了
 *   3. 读的是英文原文，界面是中文
 *
 * 已登录的人直接去 /library —— 每天读的人不该每天多点一次（user-flows §3 路径 3）。
 * 判断登录态用一次 probeAuth()，**不**包进 <RequireAuth>：那会把游客弹去登录页。
 */

import { useEffect, useMemo, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import {
  getPublicArticle,
  listPublicArticles,
  type ArticleDetailDto,
  type ArticleSummaryDto,
} from '../api/client'
import AppActions from '../components/AppActions'
import { ListPanel, ListRow } from '../components/ListPanel'
import PublicLayout from '../components/PublicLayout'
import { probeAuth, type AuthStatus } from '../lib/auth'
import { readGuestRecord } from '../lib/guestStorage'
import { TAGLINE } from '../lib/site'
import '../styles/login.css'

/** 示范短文的篇幅区间。公开库里短文是少数（design-brief §7②），没有就退回第一篇 */
const FEATURED_MIN_WORDS = 150
const FEATURED_MAX_WORDS = 400
/** 第一屏正文开头给多少词：够看出文风和难度，又不至于把 CTA 挤出首屏 */
const EXCERPT_WORDS = 90

function pickFeatured(articles: ArticleSummaryDto[]): ArticleSummaryDto | null {
  return (
    articles.find((a) => a.wordCount >= FEATURED_MIN_WORDS && a.wordCount <= FEATURED_MAX_WORDS) ??
    articles[0] ??
    null
  )
}

/** 按词数截开头几段。分词是后端做好的，这里只数、不切 */
function excerptOf(paragraphs: string[][], limit: number): string[] {
  const out: string[] = []
  let left = limit
  for (const words of paragraphs) {
    if (left <= 0) break
    if (words.length <= left) {
      out.push(words.join(' '))
      left -= words.length
    } else {
      out.push(`${words.slice(0, left).join(' ')} …`)
      left = 0
    }
  }
  return out
}

/** 游客在这台浏览器里读过没有。只看有没有标记 / 有没有读完，光打开过不算 */
function GuestRowState({ articleId }: { articleId: number }) {
  const record = readGuestRecord(articleId)
  if (record?.status === 'finished') {
    return <span className="list-row__state">读过{record.marks.length > 0 && ` · 标了 ${record.marks.length} 处`}</span>
  }
  if (record && record.marks.length > 0) {
    return (
      <span className="list-row__state is-reading">
        <span className="lamp lamp--sm" aria-hidden="true" />
        在读 · 标了 {record.marks.length} 处
      </span>
    )
  }
  return <span className="list-row__state is-unread">未读</span>
}

function FeaturedCard({
  summary,
  detail,
}: {
  summary: ArticleSummaryDto
  detail: ArticleDetailDto | null
}) {
  const excerpt = detail ? excerptOf(detail.bodyParagraphs, EXCERPT_WORDS) : null
  return (
    <article className="featured">
      <div className="featured__label">
        <span className="lamp lamp--sm" aria-hidden="true" />
        现在就能读的一篇
      </div>
      <h1 className="featured__title">{summary.title}</h1>
      <div className="meta featured__meta">
        {summary.author ?? '佚名'} · {summary.wordCount} 词 · 约 {summary.estMinutes} 分钟
      </div>

      {/* 正文开头拉不到也不挡路：标题和按钮已经够他点进去了 */}
      {excerpt ? (
        <div className="featured__excerpt" lang="en">
          {excerpt.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : (
        <div className="featured__excerpt featured__excerpt--pending" aria-hidden="true" />
      )}

      <div className="featured__cta">
        <Link className="btn-primary btn-lg" to={`/try/${summary.id}`}>
          读这一篇
        </Link>
        <span className="featured__cta-note">不用注册，读完就能导出复盘</span>
      </div>
    </article>
  )
}

/** 公开库还是 0 篇（design-brief §7①）。说清楚在准备，只留登录入口 */
function EmptyFeatured() {
  return (
    <article className="featured featured--empty">
      <div className="featured__label">
        <span className="lamp lamp--sm" aria-hidden="true" />
        第一批文章正在准备
      </div>
      <h1 className="featured__title">公开文章还没上架</h1>
      <p className="featured__text">
        第一批可以合法公开的英文原文（公版和开放授权的文章）正在整理。上架之后，
        这里会直接放一篇能读的短文，打开就读，不用注册。
      </p>
      <p className="featured__text dim">
        已经有账号？<Link to="/login">登录</Link>
      </p>
    </article>
  )
}

function LoadFailed() {
  return (
    <article className="featured featured--empty">
      <h1 className="featured__title">暂时连不上服务器</h1>
      <p className="featured__text">文章加载不出来，稍后刷新再试一次。</p>
      <p className="featured__text dim">
        已经有账号？<Link to="/login">登录</Link>
      </p>
    </article>
  )
}

export default function LandingPage() {
  const navigate = useNavigate()
  const [auth, setAuth] = useState<AuthStatus>('checking')
  const [articles, setArticles] = useState<ArticleSummaryDto[] | null>(null)
  const [listFailed, setListFailed] = useState(false)
  const [detail, setDetail] = useState<ArticleDetailDto | null>(null)

  // 两个请求并行：登录态探测和公开库互不依赖，串起来等于白等一个来回
  useEffect(() => {
    let cancelled = false
    probeAuth().then((probe) => {
      if (!cancelled) setAuth(probe.status)
    })
    listPublicArticles()
      .then((list) => {
        if (!cancelled) setArticles(list)
      })
      .catch(() => {
        if (!cancelled) setListFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const featured = useMemo(() => (articles ? pickFeatured(articles) : null), [articles])
  const others = useMemo(
    () => (articles && featured ? articles.filter((a) => a.id !== featured.id) : []),
    [articles, featured],
  )

  useEffect(() => {
    if (!featured) return
    let cancelled = false
    getPublicArticle(featured.id)
      .then((d) => {
        if (!cancelled) setDetail(d)
      })
      .catch(() => {
        // 拉不到正文开头就只显示标题，「读这一篇」照样能点
      })
    return () => {
      cancelled = true
    }
  }, [featured])

  if (auth === 'authed') return <Navigate to="/library" replace />

  if (auth === 'checking') {
    // 和守卫同一个理由：探测没回来之前什么都不画。先画落地页的话，
    // 已登录的人每次打开都会看到它闪一下再跳走。
    return (
      <>
        <AppActions />
        <div className="auth-checking" role="status" aria-busy="true" aria-label="正在确认登录状态" />
      </>
    )
  }

  const empty = articles !== null && articles.length === 0

  return (
    // 公开库是空的时候不劝人注册：注册进去也是一个空文章库。只留登录
    <PublicLayout
      actions={
        empty || listFailed ? (
          <Link className="btn-secondary" to="/login">
            登录
          </Link>
        ) : undefined
      }
    >
      <section className="landing-hero">
        <p className="landing-tagline">{TAGLINE}</p>
        <p className="landing-lede">
          一个英文阅读器。读的时候只做一件事：把卡住你的地方标出来。读完再集中解决。
        </p>

        {listFailed ? (
          <LoadFailed />
        ) : articles === null ? (
          <div className="featured featured--loading" aria-busy="true" aria-label="正在加载文章" />
        ) : featured ? (
          <FeaturedCard summary={featured} detail={detail} />
        ) : (
          <EmptyFeatured />
        )}
      </section>

      <section className="landing-section" aria-labelledby="promises-title">
        <h2 id="promises-title" className="landing-section__title">
          先说清楚三件事
        </h2>
        <ul className="promises">
          <li>
            <strong>不用注册就能完整读一篇。</strong>
            读、标、导出复盘，全程不用登录。
          </li>
          <li>
            <strong>不注册的话，记录只存在这台浏览器里，清了就没了。</strong>
            换设备、清缓存、开无痕窗口都看不到。想留住，再注册。
          </li>
          <li>
            <strong>读的是英文原文，界面是中文。</strong>
            按钮和说明都是中文，文章本身不翻译。
          </li>
        </ul>
      </section>

      <section className="landing-section" aria-labelledby="pens-title">
        <h2 id="pens-title" className="landing-section__title">
          读的时候，只有两支笔
        </h2>
        <div className="pen-cards">
          <div className="pen-card pen--yellow">
            <h3 className="pen-card__title">
              <span className="swatch" aria-hidden="true" /> 陌生词
            </h3>
            <p>点一下，标一个不认识的词；再点一下取消。</p>
          </div>
          <div className="pen-card pen--pink">
            <h3 className="pen-card__title">
              <span className="swatch" aria-hidden="true" /> 模糊处
            </h3>
            <p>每个词都认识，连起来却读不懂的那一段：点第一个词，再点最后一个词。</p>
          </div>
          <div className="pen-card">
            <h3 className="pen-card__title">读完</h3>
            <p>得到一段复盘 prompt：原文加上你标的地方。复制到你常用的 AI 对话里，让它带你过一遍。</p>
          </div>
        </div>
        <p className="landing-note">
          不查词典、不弹翻译 —— 读的时候不被打断。标少一点也没关系，有些词不懂，照样能读懂大意。
        </p>
      </section>

      {others.length > 0 && (
        <section className="landing-section" aria-labelledby="more-title">
          <h2 id="more-title" className="landing-section__title">
            其他公开文章
          </h2>
          <ListPanel columns={['标题', '篇幅', '这台浏览器里']}>
            {others.map((a) => (
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
        </section>
      )}
    </PublicLayout>
  )
}
