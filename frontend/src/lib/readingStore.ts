/**
 * 阅读会话的存储适配器：阅读器和读完页只认这一层，不直接碰 API 或 localStorage。
 *
 * 为什么要这一层：游客阅读器必须和登录后的阅读器**视觉一致，不是阉割版**
 * （design-brief §6）。复制一份 ReaderPage 的话，两份迟早长歪 —— 两支笔的手感
 * 是这个产品的命，只能有一份实现。所以页面不分叉，分叉的是「标记存到哪」：
 *
 *   server  现有 API：/sessions/:id、/sessions/:id/marks、/sessions/:id/export
 *   guest   localStorage（lib/guestStorage.ts）+ 公开接口取文章、导出
 *
 * 标记 id 由存储层发：服务端是 `s<id>`（toMark），本地是 `g…`。
 * 页面只把它当不透明字符串，删除时原样交回来。
 */

import {
  ApiError,
  createMark,
  deleteMark,
  exportPublic,
  exportSession,
  getArticle,
  getPublicArticle,
  getSession,
  toMark,
  updateSession,
  type ArticleDetailDto,
  type MarkCreatePayload,
  type SessionStatus,
} from '../api/client'
import type { Mark } from '../types'
import {
  fromGuestMark,
  guestMarkToPayload,
  newGuestMarkId,
  newGuestRecord,
  readGuestRecord,
  writeGuestRecord,
} from './guestStorage'

export interface LoadedReading {
  article: ArticleDetailDto
  status: SessionStatus
  scrollPosition: number
  /** 已经存下来的标记，id 是存储层发的 */
  marks: Mark[]
}

export interface ReadingStore {
  readonly kind: 'server' | 'guest'
  /** 换了它就等于换了一次阅读：阅读器据此重置画笔和同步状态 */
  readonly key: string
  readonly readerPath: string
  readonly reviewPath: string
  /** 阅读器顶栏的返回、出错时的退路 */
  readonly homePath: string
  readonly homeLabel: string

  load(): Promise<LoadedReading>
  /** 存一条新标记，返回存储层的 id。payload 由页面用 toMarkCreatePayload 算好（含 context） */
  addMark(mark: Mark, payload: MarkCreatePayload): Promise<string>
  removeMark(markId: string): Promise<void>
  saveScroll(y: number): Promise<void>
  finish(): Promise<void>
  /** 整份标记的崩溃保险。只有服务端实现需要 —— 本地实现自己就是持久层 */
  snapshot(marks: Mark[]): void
  exportMarkdown(): Promise<string>
}

// ---------- 服务端 ----------

export function serverReadingStore(sessionId: number, bookRunId?: number): ReadingStore {
  return {
    kind: 'server',
    key: `server:${sessionId}`,
    readerPath: `/read/${sessionId}`,
    reviewPath: `/review/${sessionId}`,
    homePath: '/library',
    homeLabel: '返回文章',

    async load() {
      const session = await getSession(sessionId)
      const article = await getArticle(session.articleId)
      return {
        article,
        status: session.status,
        scrollPosition: session.scrollPosition,
        marks: session.marks.map(toMark),
      }
    },

    async addMark(_mark, payload) {
      const dto = await createMark(sessionId, bookRunId ? { ...payload, bookRunId } : payload)
      return toMark(dto).id
    },

    async removeMark(markId) {
      const serverId = Number(markId.slice(1))
      if (!markId.startsWith('s') || !Number.isInteger(serverId)) {
        throw new Error(`不是服务端标记：${markId}`)
      }
      await deleteMark(serverId)
    },

    async saveScroll(y) {
      await updateSession(sessionId, { scrollPosition: y })
    },

    async finish() {
      await updateSession(sessionId, { status: 'finished' })
    },

    snapshot(marks) {
      // 崩溃保险：服务端才是权威数据，这份镜像**从来没有被读回过**（全仓只有这一处写、
      // 没有任何地方读）。所以改名成 foglight: 前缀时旧的 reading-saas: key 不迁移 ——
      // 它里面的每一条要么已经在服务器上，要么当时就没存上、这份镜像也救不回来。
      try {
        localStorage.setItem(`foglight:session:${sessionId}:marks`, JSON.stringify(marks))
      } catch {
        // 存不进去（隐私模式 / 配额满）不是致命问题，忽略
      }
    },

    exportMarkdown() {
      return exportSession(sessionId)
    },
  }
}

// ---------- 本地（游客） ----------

export function guestReadingStore(articleId: number): ReadingStore {
  // 第一次写的时候才建记录：光是打开看一眼不该在浏览器里留东西
  const current = () => readGuestRecord(articleId) ?? newGuestRecord(articleId)

  return {
    kind: 'guest',
    key: `guest:${articleId}`,
    readerPath: `/try/${articleId}`,
    reviewPath: `/try/${articleId}/review`,
    // 游客的「文章库」是 /explore：它记得翻到第几页，回去接着挑
    homePath: '/explore',
    homeLabel: '返回文章',

    async load() {
      let article: ArticleDetailDto
      try {
        article = await getPublicArticle(articleId)
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          throw new ApiError(404, '这篇文章不存在，或者还没公开。')
        }
        throw err
      }
      const record = readGuestRecord(articleId)
      return {
        article,
        status: record?.status ?? 'reading',
        scrollPosition: record?.scrollPosition ?? 0,
        marks: (record?.marks ?? []).map(fromGuestMark),
      }
    },

    async addMark(mark, payload) {
      const record = current()
      const id = newGuestMarkId()
      record.marks = [
        ...record.marks,
        {
          id,
          type: mark.type,
          start: mark.start,
          end: mark.end,
          text: mark.text,
          context: payload.context ?? '',
        },
      ]
      writeGuestRecord(record)
      return id
    },

    async removeMark(markId) {
      const record = readGuestRecord(articleId)
      if (!record) return
      record.marks = record.marks.filter((m) => m.id !== markId)
      writeGuestRecord(record)
    },

    async saveScroll(y) {
      const record = current()
      record.scrollPosition = y
      writeGuestRecord(record)
    },

    async finish() {
      const record = current()
      record.status = 'finished'
      record.finishedAt = new Date().toISOString()
      writeGuestRecord(record)
    },

    snapshot() {
      // 每一次 addMark / removeMark 已经写进 localStorage 了，不需要再镜像一份
    },

    exportMarkdown() {
      const marks = readGuestRecord(articleId)?.marks ?? []
      return exportPublic(articleId, marks.map(guestMarkToPayload))
    },
  }
}
