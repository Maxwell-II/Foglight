import { Link, Navigate, Route, BrowserRouter, Routes } from 'react-router-dom'
import LibraryPage from './pages/LibraryPage'
import ImportPage from './pages/ImportPage'
import ReaderPage from './pages/ReaderPage'
import ReviewPage from './pages/ReviewPage'

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
        <Route path="/" element={<LibraryPage />} />
        <Route path="/import" element={<ImportPage />} />
        <Route path="/read/:sessionId" element={<ReaderPage />} />
        <Route path="/review/:sessionId" element={<ReviewPage />} />
        <Route path="/index.html" element={<Navigate to="/" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </BrowserRouter>
  )
}
