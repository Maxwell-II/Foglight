/**
 * 应用壳（v2「雾与灯」）。
 *
 * 在这之前每个页面各自画一条 `.site-header`（品牌名重复三遍），导航靠页面里
 * 互相指的 `← 文章库 / 书架 →` 链接，主题和退出挂在右上角 fixed 的 <AppActions>。
 * 现在这些收进左侧一条 248px 的窄栏：品牌、继续读、两个平级区、导入、用户。
 *
 * ⚠️ 阅读器不套这一层（稿子里阅读器收起侧栏）—— 路由在 App.tsx 里是分开挂的。
 *
 * 顺带解决一件事：文章和书的列表以前由 LibraryPage / BooksPage 各自拉一次，
 * 侧栏也要用同一份数据算计数。所以拉取上移到这里，用 context 发下去，
 * 一次导航只打一轮请求。导入完要刷新，调用方用 useShellData().reload()。
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  listArticles,
  listBooks,
  type ArticleSummaryDto,
  type BookSummaryDto,
} from '../api/client'
import { LOGIN_PATH, signOut } from '../lib/auth'
import { useAuthUser } from './RequireAuth'
import ThemeToggle from './ThemeToggle'

interface ShellData {
  articles: ArticleSummaryDto[] | null
  books: BookSummaryDto[] | null
  /** 侧栏自己不显示错误（它得一直在），由页面决定怎么说 */
  error: string | null
  reload: () => void
}

const ShellDataContext = createContext<ShellData | null>(null)

const COLLAPSED_KEY = 'reading.sidebarCollapsed'

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

/** 只能在 <AppShell> 的子路由里调用。 */
export function useShellData(): ShellData {
  const value = useContext(ShellDataContext)
  if (!value) throw new Error('useShellData 必须在 <AppShell> 内使用')
  return value
}

// ---------- 图标。三个而已，不为此装一个图标库 ----------

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg
      className="nav-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const ArticleIcon = () => (
  <Icon>
    <path d="M6 3h9l3 3v15H6z" />
    <path d="M9 11h6" />
    <path d="M9 15h6" />
  </Icon>
)

const BookIcon = () => (
  <Icon>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H19v16H5.5A1.5 1.5 0 0 1 4 18.5z" />
    <path d="M8 4v16" />
  </Icon>
)

const ImportIcon = () => (
  <Icon>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
)

/** 收起/展开。箭头指向它按下去会去的方向：收起时指右（会展开），展开时指左。 */
const ChevronIcon = ({ pointsRight }: { pointsRight: boolean }) => (
  <Icon>{pointsRight ? <path d="M9 5l7 7-7 7" /> : <path d="M15 5l-7 7 7 7" />}</Icon>
)

// ---------- 继续读 ----------

interface Resume {
  bookId: number
  title: string
  caption: string
  /** 0–1 */
  progress: number
}

/** 第一本没读完的书。没有书、或书都读完了就不显示这张卡 —— 空卡比没有卡更占地方。 */
function pickResume(books: BookSummaryDto[]): Resume | null {
  for (const b of books) {
    if (b.readingMode === 'fixed_pages') {
      if (b.pageCount === 0 || b.finishedPageCount >= b.pageCount) continue
      return {
        bookId: b.id,
        title: b.title,
        caption: `第 ${b.finishedPageCount + 1} 页 · 共 ${b.pageCount} 页`,
        progress: b.finishedPageCount / b.pageCount,
      }
    }
    if (b.nextChapter === null || b.chapterCount === 0) continue
    return {
      bookId: b.id,
      title: b.title,
      caption: `第 ${b.nextChapter.orderIndex} 章 · 共 ${b.chapterCount} 章`,
      progress: b.finishedChapterCount / b.chapterCount,
    }
  }
  return null
}

function ResumeCard({ resume }: { resume: Resume }) {
  const pct = Math.round(resume.progress * 100)
  return (
    <Link className="resume-card" to={`/books/${resume.bookId}`}>
      <span className="resume-card__label">继续读</span>
      <span className="resume-card__title">{resume.title}</span>
      <span className="resume-card__caption">{resume.caption}</span>
      <span
        className="lamp-track"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${resume.title} 阅读进度`}
      >
        <span className="lamp-track__fill" style={{ width: `${pct}%` }} />
      </span>
    </Link>
  )
}

// ---------- 侧栏 ----------

function NavRow({
  to,
  end,
  icon,
  label,
  count,
}: {
  to: string
  end?: boolean
  icon: ReactNode
  label: string
  count: number | null
}) {
  return (
    // 收起成图标条之后 title 是唯一还能说出这是哪一栏的东西，别省
    <NavLink
      className={({ isActive }) => `nav-row${isActive ? ' is-active' : ''}`}
      to={to}
      end={end}
      title={label}
    >
      {icon}
      <span className="nav-row__label">{label}</span>
      {count !== null && <span className="nav-row__count">{count}</span>}
    </NavLink>
  )
}

function Sidebar({
  articles,
  books,
  collapsed,
  onToggle,
}: {
  articles: ArticleSummaryDto[] | null
  books: BookSummaryDto[] | null
  collapsed: boolean
  onToggle: () => void
}) {
  const navigate = useNavigate()
  const user = useAuthUser()
  const [leaving, setLeaving] = useState(false)

  const resume = books ? pickResume(books) : null
  // 只有一本书时直接进这本书，不经过书架 —— 书架上只有一张卡，那一跳是白跳的
  const booksTo = books && books.length === 1 ? `/books/${books[0].id}` : '/books'
  const name = user?.email.split('@')[0] ?? ''

  const logout = async () => {
    setLeaving(true)
    await signOut()
    navigate(LOGIN_PATH, { replace: true })
  }

  return (
    <nav className="sidebar" aria-label="主导航">
      <div className="sidebar__top">
        <Link className="sidebar__brand" to="/" title="Foglight">
          <span className="lamp" aria-hidden="true" />
          <span className="sidebar__brand-name">Foglight</span>
        </Link>
        <button
          className="icon-button sidebar__toggle"
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
        >
          <ChevronIcon pointsRight={collapsed} />
        </button>
      </div>

      {/* 收起时这张卡没地方放 —— 它整张都是字，没有能压成一个图标的版本 */}
      {resume && !collapsed && <ResumeCard resume={resume} />}

      <div className="sidebar__nav">
        <NavRow to="/" end icon={<ArticleIcon />} label="文章" count={articles?.length ?? null} />
        <NavRow to={booksTo} icon={<BookIcon />} label="书" count={books?.length ?? null} />
        {/* 稿子里这里还有第三个平级区「复盘记录」。后端没有列出历史会话的接口
            （只有 GET /sessions/{id}），做不了 —— 补上 GET /sessions 之后再加，
            不先摆一个点进去是空页的入口。 */}
      </div>

      <div className="sidebar__spacer" />

      {/* 导入和用户行是 .sidebar 的直接子元素，**不包在一个 footer 里**：
          窄屏要把它们拆到两个地方去（导入变成第三个 tab，用户行浮到右上角），
          包在一起的话就只能整块搬，两边必然有一个放错位置。 */}
      <Link className="nav-row nav-row--ghost" to="/import" title="导入文章">
        <ImportIcon />
        <span className="nav-row__label">导入文章</span>
      </Link>

      <div className="sidebar__user">
        <span className="avatar" title={user?.email}>
          {name.slice(0, 1).toUpperCase() || '·'}
        </span>
        <span className="sidebar__user-name" title={user?.email}>
          {name || '未登录'}
        </span>
        <ThemeToggle />
        <button className="logout-btn" type="button" onClick={logout} disabled={leaving} title="退出登录">
          退出
        </button>
      </div>
    </nav>
  )
}

// ---------- 壳 ----------

export default function AppShell() {
  const [articles, setArticles] = useState<ArticleSummaryDto[] | null>(null)
  const [books, setBooks] = useState<BookSummaryDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [collapsed, setCollapsed] = useState(readCollapsed)

  const reload = useCallback(() => setTick((n) => n + 1), [])

  const toggleSidebar = useCallback(() => {
    setCollapsed((was) => {
      const next = !was
      try {
        localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
      } catch {
        // 存不进去就只在本次会话里生效，不影响功能
      }
      return next
    })
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([listArticles(), listBooks()])
      .then(([a, b]) => {
        if (cancelled) return
        setArticles(a)
        setBooks(b)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [tick])

  return (
    <ShellDataContext.Provider value={{ articles, books, error, reload }}>
      <div className={`app${collapsed ? ' is-collapsed' : ''}`}>
        <Sidebar articles={articles} books={books} collapsed={collapsed} onToggle={toggleSidebar} />
        <main className="app-main">
          <Outlet />
        </main>
      </div>
    </ShellDataContext.Provider>
  )
}
