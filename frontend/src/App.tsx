import { Link, Navigate, Outlet, Route, BrowserRouter, Routes } from 'react-router-dom'
import LibraryPage from './pages/LibraryPage'
import BooksPage from './pages/BooksPage'
import BookDetailPage from './pages/BookDetailPage'
import ImportPage from './pages/ImportPage'
import ReaderPage from './pages/ReaderPage'
import ReviewPage from './pages/ReviewPage'
import AppActions from './components/AppActions'
import RequireAuth from './components/RequireAuth'
import LoginPage from './pages/LoginPage'
import BookReviewPage from './pages/BookReviewPage'

function NotFound() {
  return (
    <div className="wrap">
      <p className="dim">页面不存在。</p>
      <Link to="/">返回文章库</Link>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* /login 必须在守卫之外，否则未登录跳过来会再被弹走一次，绕成死循环。
            它自带一份只有主题按钮的 AppActions —— 未登录时没有「退出」可点。 */}
        <Route
          path="/login"
          element={
            <>
              <AppActions />
              <LoginPage />
            </>
          }
        />

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
          <Route path="/" element={<LibraryPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/books" element={<BooksPage />} />
          <Route path="/books/:bookId" element={<BookDetailPage />} />
          <Route path="/books/:bookId/review" element={<BookReviewPage />} />
          <Route path="/read/:sessionId" element={<ReaderPage />} />
          <Route path="/review/:sessionId" element={<ReviewPage />} />
          <Route path="/index.html" element={<Navigate to="/" replace />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
