/**
 * 全项目共用的类型。Phase 1 接后端时，这些要和 backend/app/schemas.py 保持一致。
 */

/** 位置：第 p 段、第 w 个词。标记全靠这个定位，不用字符偏移。 */
export interface Pos {
  p: number
  w: number
}

export type MarkType = 'unknown_word' | 'unclear'

export interface Mark {
  id: string
  type: MarkType
  /** 起点（含） */
  start: Pos
  /** 终点（含）。陌生词时 start === end */
  end: Pos
  /** 标记覆盖的原文，冗余存一份方便导出 */
  text: string
}

export interface Article {
  id: number
  title: string
  author: string
  source: string
  /** 原文地址，给 meta 行的出处链接用；粘贴导入、书页没有 */
  sourceUrl: string | null
  wordCount: number
  estMinutes: number
  /**
   * 已经切好词的正文：第一层是段落，第二层是词。
   * ⚠️ 分词由后端负责，前端只渲染，绝不自己切 —— 否则标记会错位。
   */
  paragraphs: string[][]
}

/** 两支笔 */
export type Pen = 'yellow' | 'pink'

/**
 * 画笔状态机。
 *   idle      黄笔：点词直接切换「陌生词」
 *   armed     粉笔已选，等你点起点
 *   extending 起点已定，跟着鼠标实时预览，再点一下提交
 */
export type MarkingState =
  | { kind: 'idle' }
  | { kind: 'armed' }
  | { kind: 'extending'; anchor: Pos; hover: Pos }
