import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ApiError,
  importText,
  previewText,
  type ArticlePreviewDto,
  type ParagraphMode,
} from '../api/client'

const LEVEL_LABELS: Record<ArticlePreviewDto['level'], string> = {
  short: '短文',
  medium: '中等',
  long: '长文',
}

const PREVIEW_DEBOUNCE_MS = 400

export default function ImportPage() {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [sourceName, setSourceName] = useState('')
  const [text, setText] = useState('')
  const [paragraphMode, setParagraphMode] = useState<ParagraphMode>('blank_line')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [preview, setPreview] = useState<ArticlePreviewDto | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  useEffect(() => {
    if (text.trim() === '') {
      setPreview(null)
      setPreviewError(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      previewText({ text, paragraphMode })
        .then((result) => {
          if (!cancelled) {
            setPreview(result)
            setPreviewError(null)
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setPreview(null)
            setPreviewError(err instanceof Error ? err.message : String(err))
          }
        })
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [text, paragraphMode])

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
        paragraphMode,
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
          <span>正文 *</span>
          <textarea
            className="import-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            required
          />
        </label>

        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={paragraphMode === 'single_line'}
            onChange={(e) => setParagraphMode(e.target.checked ? 'single_line' : 'blank_line')}
          />
          <span>每行单独成段（贴的是一句一行的短文时勾上）</span>
        </label>

        {previewError && <p className="dim">预览失败：{previewError}</p>}

        {preview && (
          <div className="import-preview">
            <p className="import-preview__summary">
              将分成 {preview.paragraphCount} 段 · 共 {preview.wordCount} 词 · 篇幅：
              {LEVEL_LABELS[preview.level]}
            </p>
            {preview.firstParagraphs.length > 0 && (
              <div className="import-preview__paragraphs">
                {preview.firstParagraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            )}
          </div>
        )}

        {error && <p className="error-banner">{error}</p>}

        <button className="btn-primary" type="submit" disabled={submitting}>
          {submitting ? '导入中…' : '导入'}
        </button>
      </form>
    </div>
  )
}
