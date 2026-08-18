/**
 * 后端 API 封装（数据层）。
 *
 * 这里的 DTO 类型是 backend/app/schemas.py 的镜像：响应体本身就是 camelCase
 * （schemas.py 用 alias_generator=to_camel），字段名和后端逐一对应。
 *
 * 和 ../types.ts 不是一回事：那边是画笔状态机用的前端内部形状（Article.source /
 * Article.paragraphs、Mark.start/end 是 Pos），这边是网络层的原始响应形状
 * （sourceType/sourceName/sourceUrl 分开、bodyParagraphs、startParagraphIdx 等）。
 * 两者的转换集中在文件末尾的 toArticle / toMark / toMarkCreatePayload，页面不
 * 自己拼字段，避免两处对不上。
 */

import type { Article, Mark, MarkType } from '../types'

const BASE = '/api'

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new ApiError(resp.status, detail || `请求失败（${resp.status}）`)
  }
  if (resp.status === 204) return undefined as T
  return (await resp.json()) as T
}

// ---------- 后端响应形状（见 backend/app/schemas.py） ----------

export type ArticleLevel = 'short' | 'medium' | 'long'

export interface ArticleSummaryDto {
  id: number
  title: string
  author: string | null
  sourceType: string
  wordCount: number
  estMinutes: number
  topics: string[]
  difficulty: number | null
  /** 篇幅档位，后端唯一计算（Article.level property）——前端只按返回值分组，不自己按 wordCount 判断。 */
  level: ArticleLevel
  createdAt: string
}

export interface ArticleDetailDto extends ArticleSummaryDto {
  sourceUrl: string | null
  sourceName: string | null
  license: string
  redistributable: boolean
  bodyParagraphs: string[][]
}

export interface MarkDto {
  id: number
  type: MarkType
  startParagraphIdx: number
  startWordIdx: number
  endParagraphIdx: number
  endWordIdx: number
  surfaceText: string
  context: string
  createdAt: string
}

export type SessionStatus = 'reading' | 'finished' | 'abandoned'

export interface SessionDto {
  id: number
  articleId: number
  status: SessionStatus
  scrollPosition: number
  startedAt: string
  finishedAt: string | null
}

export interface SessionDetailDto extends SessionDto {
  marks: MarkDto[]
}

export interface MarkCreatePayload {
  type: MarkType
  startParagraphIdx: number
  startWordIdx: number
  endParagraphIdx: number
  endWordIdx: number
  surfaceText: string
  context?: string
}

export type ParagraphMode = 'blank_line' | 'single_line'

export interface ImportTextPayload {
  title: string
  author?: string
  sourceName?: string
  text: string
  paragraphMode?: ParagraphMode
}

export interface PreviewTextPayload {
  text: string
  paragraphMode?: ParagraphMode
}

export interface ArticlePreviewDto {
  paragraphCount: number
  wordCount: number
  level: ArticleLevel
  firstParagraphs: string[]
}

// ---------- 请求函数 ----------

export function listArticles(): Promise<ArticleSummaryDto[]> {
  return request('/articles')
}

export function getArticle(id: number): Promise<ArticleDetailDto> {
  return request(`/articles/${id}`)
}

export function importText(payload: ImportTextPayload): Promise<ArticleDetailDto> {
  return request('/articles/import/text', { method: 'POST', body: JSON.stringify(payload) })
}

/** 预览分段结果，不入库。用于导入页的粘贴预览（防抖后调用）。 */
export function previewText(payload: PreviewTextPayload): Promise<ArticlePreviewDto> {
  return request('/articles/preview/text', { method: 'POST', body: JSON.stringify(payload) })
}

export function createSession(articleId: number): Promise<SessionDto> {
  return request('/sessions', { method: 'POST', body: JSON.stringify({ articleId }) })
}

export function getSession(id: number): Promise<SessionDetailDto> {
  return request(`/sessions/${id}`)
}

export function updateSession(
  id: number,
  patch: { status?: SessionStatus; scrollPosition?: number },
): Promise<SessionDto> {
  return request(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
}

/** 纯文本 Markdown，不是 JSON —— 不走 request()，直接 fetch。 */
export async function exportSession(id: number): Promise<string> {
  const resp = await fetch(`${BASE}/sessions/${id}/export`)
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new ApiError(resp.status, detail || `导出失败（${resp.status}）`)
  }
  return resp.text()
}

export function createMark(sessionId: number, payload: MarkCreatePayload): Promise<MarkDto> {
  return request(`/sessions/${sessionId}/marks`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function deleteMark(id: number): Promise<void> {
  return request(`/marks/${id}`, { method: 'DELETE' })
}

// ---------- DTO ↔ 前端内部类型（types.ts） ----------

/** ArticleDetailDto → 画笔状态机用的 Article。source 走 sourceName → sourceUrl → sourceType 兜底，和后端导出的来源行逻辑一致。 */
export function toArticle(dto: ArticleDetailDto): Article {
  return {
    id: dto.id,
    title: dto.title,
    author: dto.author ?? '',
    source: dto.sourceName ?? dto.sourceUrl ?? dto.sourceType,
    wordCount: dto.wordCount,
    estMinutes: dto.estMinutes,
    // ⚠️ 已经是后端分好词的结果，直接用，不能再 split 一次
    paragraphs: dto.bodyParagraphs,
  }
}

/** 服务端已落库的标记 → 前端 Mark。id 加 "s" 前缀，和 useMarking 本地生成的 "m1" 之类的 id 区分开，两个 id 空间永不冲突。 */
export function toMark(dto: MarkDto): Mark {
  return {
    id: `s${dto.id}`,
    type: dto.type,
    start: { p: dto.startParagraphIdx, w: dto.startWordIdx },
    end: { p: dto.endParagraphIdx, w: dto.endWordIdx },
    text: dto.surfaceText,
  }
}

const CONTEXT_MAX_CHARS = 240

/** 前端 Mark → 建标记的请求体。context 用标记起点所在段落，截断规则和后端 export.py 的 _context_for 一致。 */
export function toMarkCreatePayload(mark: Mark, paragraphs: string[][]): MarkCreatePayload {
  const raw = paragraphs[mark.start.p]?.join(' ') ?? ''
  const context = raw.length > CONTEXT_MAX_CHARS ? `${raw.slice(0, CONTEXT_MAX_CHARS)}…` : raw
  return {
    type: mark.type,
    startParagraphIdx: mark.start.p,
    startWordIdx: mark.start.w,
    endParagraphIdx: mark.end.p,
    endWordIdx: mark.end.w,
    surfaceText: mark.text,
    context,
  }
}
