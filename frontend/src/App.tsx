import { Link, Navigate, Outlet, Route, BrowserRouter, Routes } from 'react-router-dom'
import LibraryPage from './pages/LibraryPage'
import BooksPage from './pages/BooksPage'
import BookDetailPage from './pages/BookDetailPage'
import ImportPage from './pages/ImportPage'
import ReaderPage from './pages/ReaderPage'
import ReviewPage from './pages/ReviewPage'
import AppActions from './components/AppActions'
import AppShell from './components/AppShell'
import PublicLayout from './components/PublicLayout'
import RequireAuth, { useAuthUser } from './components/RequireAuth'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import ForgotPage from './pages/ForgotPage'
import PrivacyPage from './pages/PrivacyPage'
import BookReviewPage from './pages/BookReviewPage'

function NotFound() {
  return (
    <div className="page">
      <p className="dim">页面不存在。</p>
      <Link to="/library">返回文章</Link>
    </div>
  )
}

/** 公开版不给导入入口（public-release.md §2）。侧栏已经不画了，这里挡住直接敲地址进来的 */
function RequireCanImport() {
  const user = useAuthUser()
  return user?.canImport ? <ImportPage /> : <Navigate to="/library" replace />
}

/**
 * 路由分三层：
 *   公开        落地页、游客阅读、登录 / 注册 / 忘记密码 —— 不经过守卫
 *   要登录      守卫一层；阅读器在壳外，其余页面套 <AppShell>
 *
 * ⚠️ 公开页面**不能**包进 <RequireAuth>：未登录会被弹去登录页。
 * 它们要知道登录态时自己打一次 /auth/me（落地页就是这么做的）。
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* ---------- 公开 ---------- */}

        {/* 落地页。已登录的人它自己会跳 /library */}
        <Route path="/" element={<LandingPage />} />
        <Route path="/index.html" element={<Navigate to="/" replace />} />

        {/* 游客阅读器：和 /read/:sessionId 是同一个组件，只是存储走 localStorage。
            和登录后的阅读器一样不套任何壳，整屏只剩正文。 */}
        <Route path="/try/:articleId" element={<ReaderPage mode="guest" />} />
        <Route
          path="/try/:articleId/review"
          element={
            <PublicLayout>
              <ReviewPage mode="guest" />
            </PublicLayout>
          }
        />

        {/* 登录 / 注册 / 忘记密码必须在守卫之外，否则未登录跳过来会再被弹走一次，
            绕成死循环。各自带一份只有主题按钮的 AppActions —— 未登录时没有「退出」可点。 */}
        <Route
          path="/login"
          element={
            <>
              <AppActions />
              <LoginPage />
            </>
          }
        />
        <Route
          path="/register"
          element={
            <>
              <AppActions />
              <RegisterPage />
            </>
          }
        />
        <Route
          path="/forgot"
          element={
            <>
              <AppActions />
              <ForgotPage />
            </>
          }
        />
        <Route
          path="/privacy"
          element={
            <>
              <AppActions />
              <PrivacyPage />
            </>
          }
        />

        {/* ---------- 要登录 ---------- */}

        {/* 无路径的 layout route：守卫只挂一层，页面之间切换不重挂，
            所以 /auth/me 全程只打一次。
            ⚠️ 不要写成「父路由 path="*" 里再嵌一个 <Routes>」—— 那样子级的
            绝对路径（/books 这种）会在运行时报 "Absolute route path nested
            under..."，而 tsc 检查不出来。 */}
        <Route
          element={
            <RequireAuth>
              <Outlet />
            </RequireAuth>
          }
        >
          {/* 阅读器**故意在壳外面**：稿子里读的时候侧栏收起，整屏只剩正文。
              它也是唯一一个自带顶栏的页面。 */}
          <Route path="/read/:sessionId" element={<ReaderPage mode="server" />} />

          {/* 其余页面套 <AppShell>：左侧栏 + 主区。壳是 layout route，
              页面之间切换时不重挂，所以侧栏那轮 /articles + /books 只打一次。 */}
          <Route element={<AppShell />}>
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/import" element={<RequireCanImport />} />
            <Route path="/books" element={<BooksPage />} />
            <Route path="/books/:bookId" element={<BookDetailPage />} />
            <Route path="/books/:bookId/review" element={<BookReviewPage />} />
            <Route path="/review/:sessionId" element={<ReviewPage mode="server" />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
