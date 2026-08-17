import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ApiError, importText } from '../api/client'

export default function ImportPage() {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wordCount = text.trim() === '' ? 0 : text.trim().split(/\s+/).length

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !text.trim()) {
      setError('标题和正文都不能为空。')
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await importText({
        title: title.trim(),
        author: author.trim() || undefined,
        sourceName: sourceName.trim() || undefined,
        text,
      })
      navigate('/')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '导入失败，请重试。')
      setSubmitting(false)
    }
  }

  return (
    <div className="wrap">
      <Link className="back-link" to="/">
        ← 返回文章库
      </Link>
      <h1 className="title">粘贴正文导入</h1>
      <p className="dim">
        分词由后端统一处理，这里只要贴纯文本；段落之间空一行即可。
      </p>

      <form className="import-form" onSubmit={onSubmit}>
        <label className="field">
          <span>标题 *</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        <label className="field">
          <span>作者</span>
          <input value={author} onChange={(e) => setAuthor(e.target.value)} />
        </label>
        <label className="field">
          <span>来源</span>
          <input
            value={sourceName}
            onChange={(e) => setSourceName(e.target.value)}
            placeholder="书名 / 站点名，随便写"
          />
        </label>
        <label className="field">
          <span>正文 *（约 {wordCount} 词）</span>
          <textarea
            className="import-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        </label>

        {error && <p className="error-banner">{error}</p>}

        <button className="btn-primary" type="submit" disabled={submitting}>
          {submitting ? '导入中…' : '导入'}
        </button>
      </form>
    </div>
  )
}
