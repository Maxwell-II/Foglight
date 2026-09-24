/**
 * 游客的阅读记录：一篇文章一条，存在 localStorage 的 `foglight:guest:<articleId>`。
 *
 * 游客不建匿名用户行（public-release.md §4）：读 → 标 → 导出这个闭环本来就不需要服务器，
 * 服务器的价值是跨设备和历史积累 —— 那正好是注册要换的东西。
 * 所以「清了浏览器就没了」是设计后果，落地页和读完页都要把这句话说出来。
 *
 * ⚠️ localStorage 随时可能不可用（隐私模式、被禁用、配额满），所有读写都 try/catch。
 * 不可用时退回到模块内的内存副本：本标签页里照常能读、能标、能导出，只是关掉就没了。
 * 登录后的迁移也会扫这份内存副本 —— 登录是站内跳转，不刷新页面，内存里的东西还在。
 */

import type { MarkCreatePayload } from '../api/client'
import type { Mark, MarkType, Pos } from '../types'

const PREFIX = 'foglight:guest:'

/** 本地标记。比 Mark 多存一份 context：迁移和导出时手里没有文章正文，算不出来 */
export interface GuestMark {
  /** 本地 id，`g` 开头 —— 和 useMarking 的 `m1`、服务端的 `s12` 三个 id 空间永不冲突 */
  id: string
  type: MarkType
  start: Pos
  end: Pos
  text: string
  context: string
}

export interface GuestRecord {
  /** 形状版本。以后改结构时靠它认出旧数据，而不是猜 */
  v: 1
  articleId: number
  status: 'reading' | 'finished'
  marks: GuestMark[]
  startedAt: string
  finishedAt: string | null
  scrollPosition: number
  updatedAt: string
}

/** localStorage 不可用时的退路，也是「写进去失败」时的最新副本 */
const memory = new Map<number, GuestRecord>()

const keyOf = (articleId: number) => `${PREFIX}${articleId}`

function isPos(x: unknown): x is Pos {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Pos).p === 'number' &&
    typeof (x as Pos).w === 'number'
  )
}

function isGuestMark(x: unknown): x is GuestMark {
  if (typeof x !== 'object' || x === null) return false
  const m = x as GuestMark
  return (
    typeof m.id === 'string' &&
    (m.type === 'unknown_word' || m.type === 'unclear') &&
    isPos(m.start) &&
    isPos(m.end) &&
    typeof m.text === 'string'
  )
}

/** 手改过、或者以后换了结构的数据：认不出就当没有，不让一条坏记录把阅读器弄崩 */
function parseRecord(raw: string, articleId: number): GuestRecord | null {
  try {
    const x = JSON.parse(raw) as Partial<GuestRecord>
    if (x.v !== 1 || x.articleId !== articleId || !Array.isArray(x.marks)) return null
    return {
      v: 1,
      articleId,
      status: x.status === 'finished' ? 'finished' : 'reading',
      marks: x.marks.filter(isGuestMark).map((m) => ({ ...m, context: m.context ?? '' })),
      startedAt: typeof x.startedAt === 'string' ? x.startedAt : new Date().toISOString(),
      finishedAt: typeof x.finishedAt === 'string' ? x.finishedAt : null,
      scrollPosition: typeof x.scrollPosition === 'number' ? x.scrollPosition : 0,
      updatedAt: typeof x.updatedAt === 'string' ? x.updatedAt : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

/** 这个浏览器能不能真的存下来。阅读器用它决定要不要提醒「关掉就没了」 */
export function guestStorageAvailable(): boolean {
  try {
    const probe = `${PREFIX}__probe`
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

export function newGuestRecord(articleId: number): GuestRecord {
  const now = new Date().toISOString()
  return {
    v: 1,
    articleId,
    status: 'reading',
    marks: [],
    startedAt: now,
    finishedAt: null,
    scrollPosition: 0,
    updatedAt: now,
  }
}

/**
 * localStorage 读得到就以它为准（别的标签页可能改过）；
 * 读不了、或者里面没有（上次写入失败了），才用内存副本。
 */
export function readGuestRecord(articleId: number): GuestRecord | null {
  try {
    const raw = localStorage.getItem(keyOf(articleId))
    if (raw !== null) return parseRecord(raw, articleId)
  } catch {
    // 落到下面的内存副本
  }
  return memory.get(articleId) ?? null
}

export function writeGuestRecord(record: GuestRecord): void {
  const next = { ...record, updatedAt: new Date().toISOString() }
  memory.set(record.articleId, next)
  try {
    localStorage.setItem(keyOf(record.articleId), JSON.stringify(next))
  } catch {
    // 存不进去：内存里那份还在，本标签页照常能用
  }
}

/** 扫出所有游客记录（localStorage + 只活在内存里的那些） */
export function listGuestRecords(): GuestRecord[] {
  const byId = new Map<number, GuestRecord>()
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(PREFIX)) continue
      const articleId = Number(key.slice(PREFIX.length))
      if (!Number.isInteger(articleId) || articleId <= 0) continue
      const raw = localStorage.getItem(key)
      const record = raw === null ? null : parseRecord(raw, articleId)
      if (record) byId.set(articleId, record)
    }
  } catch {
    // 扫不了就只剩内存副本
  }
  for (const [articleId, record] of memory) {
    if (!byId.has(articleId)) byId.set(articleId, record)
  }
  return [...byId.values()]
}

/** 迁移成功之后才调用。失败时绝不能删 —— 这类数据丢了，人不会再回来 */
export function removeGuestRecords(articleIds: number[]): void {
  for (const articleId of articleIds) {
    memory.delete(articleId)
    try {
      localStorage.removeItem(keyOf(articleId))
    } catch {
      // 删不掉也不要紧：内存那份已经没了，下次扫描会再问一次，服务端去不去重由它决定
    }
  }
}

export function newGuestMarkId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function fromGuestMark(m: GuestMark): Mark {
  return { id: m.id, type: m.type, start: m.start, end: m.end, text: m.text }
}

/** 本地标记 → 建标记的请求体（导出和迁移共用）。bookRunId 显式给 null：游客只读散篇 */
export function guestMarkToPayload(m: GuestMark): MarkCreatePayload {
  return {
    type: m.type,
    startParagraphIdx: m.start.p,
    startWordIdx: m.start.w,
    endParagraphIdx: m.end.p,
    endWordIdx: m.end.w,
    surfaceText: m.text,
    context: m.context,
    bookRunId: null,
  }
}

// ---------- 登录后的迁移询问：「暂不」只在本标签页内有效 ----------

const DISMISS_KEY = 'foglight:guest-import-dismissed'

export function isGuestImportDismissed(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissGuestImport(): void {
  try {
    sessionStorage.setItem(DISMISS_KEY, '1')
  } catch {
    // 记不住就下次进来再问一遍，多问一次不丢数据
  }
}

/** 登录 / 注册成功时调用：同一个标签页里退出再登录，也算「下次登录」，要再问 */
export function resetGuestImportDismissal(): void {
  try {
    sessionStorage.removeItem(DISMISS_KEY)
  } catch {
    // 同上
  }
}
