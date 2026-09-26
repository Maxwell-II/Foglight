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

/** FastAPI 的错误体是 `{"detail": "..."}`，ApiError.message 里存的是原文。取出字符串形态的 detail，取不到给 null。 */
export function apiDetail(err: ApiError): string | null {
  try {
    const detail: unknown = JSON.parse(err.message)?.detail
    return typeof detail === 'string' ? detail : null
  } catch {
    return null
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    // 登录会话是 HttpOnly cookie（Wave 3 §1.13）。不带这个，cookie 不会被发出去，
    // 症状是"登录返回 200 但每个接口都 401"。
    credentials: 'same-origin',
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
  /** 读完过没有（存在任一 finished 会话）。后端唯一计算，前端不碰会话表。 */
  isRead: boolean
  /** 最近一个未完成会话。有它就直接进去续读，**不要再新建** ——
   *  每点一次新建一个的话，上一次的标记会被孤立、再也回不去。 */
  resumeSessionId: number | null
  /** 最近一个标过东西的会话，以及标记数。回到上一次标记的唯一入口。 */
  lastMarksSessionId: number | null
  lastMarksCount: number
  createdAt: string
}

export interface ArticleDetailDto extends ArticleSummaryDto {
  sourceUrl: string | null
  sourceName: string | null
  license: string
  redistributable: boolean
  bodyParagraphs: string[][]
  bookPageLayout: BookPageLayoutItem[] | null
  bookContext: BookPageContextDto | null
}

export type BookPageLayoutItem =
  | { type: 'paragraph'; pIdx: number }
  | { type: 'heading'; text: string }
  | { type: 'image'; assetKey: string }

export interface BookPageContextDto {
  bookId: number
  readingMode: string
  sectionId: number
  sectionTitle: string
  pageNumber: number
  pageCount: number
  previousArticleId: number | null
  nextArticleId: number | null
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
  /** 书籍阅读批次。游客导出 / 本地迁移时显式给 null（契约要求），散篇登录阅读时省略 */
  bookRunId?: number | null
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
  // ⚠️ 这是文件里第二处 fetch。只给 request() 加 credentials 会漏掉这里，
  //    症状很隐蔽：整个应用都正常，唯独点"导出"时 401 —— 而导出是这个产品
  //    价值链的最后一环。
  const resp = await fetch(`${BASE}/sessions/${id}/export`, { credentials: 'same-origin' })
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

// ---------- 书（Wave 3 §1.14 冻结契约：Round 2 的包只许消费，不许改这一段）----------

export interface ChapterSummaryDto extends ArticleSummaryDto {
  orderIndex: number
}

export interface BookSummaryDto {
  id: number
  title: string
  author: string | null
  chapterCount: number
  finishedChapterCount: number
  totalMarks: number
  /** order_index 最小的、尚未读完的那一章；整本读完为 null */
  nextChapter: { articleId: number; title: string; orderIndex: number } | null
  readingMode: 'legacy_chapters' | 'fixed_pages'
  pageCount: number
  finishedPageCount: number
  pendingReviewCount: number
}

export interface BookDetailDto extends BookSummaryDto {
  chapters: ChapterSummaryDto[]
}

export function listBooks(): Promise<BookSummaryDto[]> {
  return request('/books')
}

export function getBook(bookId: number): Promise<BookDetailDto> {
  return request(`/books/${bookId}`)
}

export interface BookSectionDto {
  id: number
  orderIndex: number
  title: string
  kind: string
  partTitle: string | null
  firstPage: number
  lastPage: number
  pageCount: number
  finishedPageCount: number
}

export interface BookTocDto {
  bookId: number
  title: string
  author: string | null
  pageCount: number
  finishedPageCount: number
  pendingReviewCount: number
  activeRunId: number | null
  resumeArticleId: number | null
  sections: BookSectionDto[]
}

export interface BookPageSummaryDto {
  articleId: number
  pageNumber: number
  title: string
  wordCount: number
  isRead: boolean
  markCount: number
}

export interface ReadingRunDto {
  id: number
  bookId: number
  currentSessionId: number | null
  recommendedArticleId: number
  startedAt: string
  endedAt: string | null
}

export interface ReviewCandidateMarkDto {
  id: number
  type: MarkType
  surfaceText: string
  startParagraphIdx: number
  startWordIdx: number
}

export interface ReviewCandidatePageDto {
  articleId: number
  pageNumber: number
  sectionTitle: string
  currentMarks: ReviewCandidateMarkDto[]
  earlierMarks: ReviewCandidateMarkDto[]
}

export interface ReviewBatchSummaryDto {
  id: number
  pageNumbers: number[]
  markCount: number
  createdAt: string
  handledAt: string | null
}

export interface ReviewCandidatesDto {
  runId: number | null
  pages: ReviewCandidatePageDto[]
  openBatches: ReviewBatchSummaryDto[]
}

export interface ReviewBatchDto extends ReviewBatchSummaryDto {
  bookId: number
  markdown: string
}

export function getBookToc(bookId: number): Promise<BookTocDto> {
  return request(`/books/${bookId}/toc`)
}

export function getBookPages(bookId: number, sectionId: number): Promise<BookPageSummaryDto[]> {
  return request(`/books/${bookId}/pages?sectionId=${sectionId}`)
}

export function startBookReading(bookId: number): Promise<ReadingRunDto> {
  return request(`/books/${bookId}/reading-runs`, { method: 'POST' })
}

export function openBookPage(bookId: number, runId: number, articleId: number) {
  return request<{ runId: number; sessionId: number; bookContext: BookPageContextDto }>(
    `/books/${bookId}/reading-runs/${runId}/open-page`,
    { method: 'POST', body: JSON.stringify({ articleId }) },
  )
}

export function finishBookReading(bookId: number, runId: number) {
  return request<{ runId: number; bookId: number; pendingCount: number }>(
    `/books/${bookId}/reading-runs/${runId}/finish`,
    { method: 'POST' },
  )
}

export function getReviewCandidates(bookId: number, runId?: number): Promise<ReviewCandidatesDto> {
  return request(`/books/${bookId}/review-candidates${runId ? `?runId=${runId}` : ''}`)
}

export function createReviewBatch(
  bookId: number,
  payload: { runId?: number; markIds: number[]; requestKey: string },
): Promise<ReviewBatchDto> {
  return request(`/books/${bookId}/review-batches`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getReviewBatch(bookId: number, batchId: number): Promise<ReviewBatchDto> {
  return request(`/books/${bookId}/review-batches/${batchId}`)
}

export function handleReviewBatch(bookId: number, batchId: number): Promise<ReviewBatchSummaryDto> {
  return request(`/books/${bookId}/review-batches/${batchId}/handle`, { method: 'POST' })
}

/** 章节区间是闭区间，按 orderIndex；省略则整本。纯文本 Markdown，同样不走 request()。 */
export async function exportBook(
  bookId: number,
  range?: { from: number; to: number },
): Promise<string> {
  const qs = range ? `?from=${range.from}&to=${range.to}` : ''
  const resp = await fetch(`${BASE}/books/${bookId}/export${qs}`, {
    credentials: 'same-origin',
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new ApiError(resp.status, detail || `导出失败（${resp.status}）`)
  }
  return resp.text()
}

// ---------- 登录（同上，冻结）----------

export interface MeDto {
  id: number
  email: string
  /** 能不能用「导入文章」。公开版只给 owner，其余账号侧栏不出这一项、/import 直接弹回文章库 */
  canImport: boolean
}

export interface LoginResult {
  ok: boolean
  /** true 表示失败次数已达阈值，前端要去取验证码再试 */
  needsCaptcha: boolean
  /** 被锁定时的剩余秒数，未锁定为 0 */
  lockedForSeconds: number
}

export interface CaptchaDto {
  id: string
  /** 内联 SVG 字符串，前端用 dangerouslySetInnerHTML 渲染 */
  svg: string
}

/**
 * ⚠️ 登录失败返回的是 200 + { ok: false }，不是 401。
 * 401 的语义是"你没权限访问这个资源"，而 /auth/login 本来就该让未登录的人访问；
 * 更实际的原因是前端会给 401 装全局拦截器（跳登录页），登录失败再触发一次跳转会绕进循环。
 */
export function login(payload: {
  email: string
  password: string
  captchaId?: string
  captchaAnswer?: string
}): Promise<LoginResult> {
  return request('/auth/login', { method: 'POST', body: JSON.stringify(payload) })
}

export function logout(): Promise<void> {
  return request('/auth/logout', { method: 'POST' })
}

/** 未登录时抛 ApiError(401)。调用方据此决定跳不跳登录页。 */
export function getMe(): Promise<MeDto> {
  return request('/auth/me')
}

export function getCaptcha(): Promise<CaptchaDto> {
  return request('/auth/captcha')
}

/** 后端开了哪些第三方登录。Google 没配好时是 false，前端就不画那个按钮 ——
 *  一个点下去必然报错的按钮，比没有按钮更糟。 */
export function getAuthProviders(): Promise<{ google: boolean }> {
  return request('/auth/providers')
}

/**
 * 注册。成功是 201 + 用户，并且后端已经写好登录 cookie，不用再调一次 login。
 * 失败靠状态码区分：400 验证码不对 / 409 已注册 / 422 校验不过 / 429 限流 —— 调用方按 ApiError.status 分支。
 * 验证码必带，且提交一次就作废（答对答错都是）：任何失败之后都要换一张新图。
 */
export function register(payload: {
  email: string
  password: string
  captchaId: string
  captchaAnswer: string
}): Promise<MeDto> {
  return request('/auth/register', { method: 'POST', body: JSON.stringify(payload) })
}

/** Google 登录的起点。浏览器整页跳过去，不是 fetch —— 回调要带着 cookie 落回本站。 */
export const GOOGLE_START_URL = `${BASE}/auth/google/start?next=/library`

// ---------- 公开库 / 游客（不需要登录）----------

/** 公开库。后端硬编码只返回 created_by IS NULL 且 redistributable 的文章，形状和 /articles 一样 */
export function listPublicArticles(): Promise<ArticleSummaryDto[]> {
  return request('/public/articles')
}

/** 不公开（或不存在）的一律 404 —— 不区分，免得拿来探测私有文章 id */
export function getPublicArticle(id: number): Promise<ArticleDetailDto> {
  return request(`/public/articles/${id}`)
}

/**
 * 游客导出。标记在浏览器里，所以连同 articleId 一起交给后端，由和登录用户同一个
 * build_markdown() 生成 —— 导出只能有一份实现，那段复盘指令就是产品的交付物。
 * 返回纯文本 Markdown，同样不走 request()。
 */
export async function exportPublic(articleId: number, marks: MarkCreatePayload[]): Promise<string> {
  const resp = await fetch(`${BASE}/public/export`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ articleId, marks }),
  })
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '')
    throw new ApiError(resp.status, detail || `导出失败（${resp.status}）`)
  }
  return resp.text()
}

export interface MarksImportPayload {
  sessions: { articleId: number; finished: boolean; marks: MarkCreatePayload[] }[]
}

/** 一次最多带多少个 session（后端 MAX_IMPORT_SESSIONS）。超过的由调用方分批 */
export const MARKS_IMPORT_BATCH = 50

export interface MarksImportResultDto {
  importedSessions: number
  importedMarks: number
  /** 看不到的文章（多半是已经下架）不报错，跳过并列在这里 */
  skippedArticleIds: number[]
}

/** 把游客时期的本地标记搬进账号。**一批之内**全部成功或全部失败 */
export function importMarks(payload: MarksImportPayload): Promise<MarksImportResultDto> {
  return request('/marks/import', { method: 'POST', body: JSON.stringify(payload) })
}

// ---------- DTO ↔ 前端内部类型（types.ts） ----------

/** ArticleDetailDto → 画笔状态机用的 Article。source 走 sourceName → sourceUrl → sourceType 兜底，和后端导出的来源行逻辑一致。 */
export function toArticle(dto: ArticleDetailDto): Article {
  return {
    id: dto.id,
    title: dto.title,
    author: dto.author ?? '',
    source: dto.sourceName ?? dto.sourceUrl ?? dto.sourceType,
    sourceUrl: dto.sourceUrl,
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
export function toMarkCreatePayload(
  mark: Mark,
  paragraphs: string[][],
  bookRunId?: number,
): MarkCreatePayload {
  const raw = paragraphs[mark.start.p]?.join(' ') ?? ''
  const words = paragraphs[mark.start.p] ?? []
  const wordStart = words.slice(0, mark.start.w).reduce((total, word) => total + word.length + 1, 0)
  const start = Math.max(0, Math.min(wordStart - CONTEXT_MAX_CHARS / 2, raw.length - CONTEXT_MAX_CHARS))
  const context =
    raw.length > CONTEXT_MAX_CHARS
      ? `${start > 0 ? '…' : ''}${raw.slice(start, start + CONTEXT_MAX_CHARS)}${start + CONTEXT_MAX_CHARS < raw.length ? '…' : ''}`
      : raw
  return {
    type: mark.type,
    startParagraphIdx: mark.start.p,
    startWordIdx: mark.start.w,
    endParagraphIdx: mark.end.p,
    endWordIdx: mark.end.w,
    surfaceText: mark.text,
    context,
    ...(bookRunId === undefined ? {} : { bookRunId }),
  }
}
