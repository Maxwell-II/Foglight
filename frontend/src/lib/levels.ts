/**
 * 篇幅档位筛选：文章库（登录）和公开文章页（游客）共用。
 * 档位本身由后端按词数算好（ArticleSummaryDto.level），这里只管显示和计数。
 */

import type { ArticleLevel } from '../api/client'

export type LevelFilter = ArticleLevel | 'all'

export const LEVEL_ORDER = ['short', 'medium', 'long', 'all'] as const

export const LEVEL_LABELS: Record<LevelFilter, string> = {
  short: '短文',
  medium: '中等',
  long: '长文',
  all: '全部',
}

export function countLevels(articles: { level: ArticleLevel }[] | null): Record<LevelFilter, number> {
  const base: Record<LevelFilter, number> = { short: 0, medium: 0, long: 0, all: 0 }
  for (const a of articles ?? []) {
    base[a.level] += 1
    base.all += 1
  }
  return base
}

export function filterLevel<T extends { level: ArticleLevel }>(articles: T[] | null, level: LevelFilter): T[] | null {
  if (!articles) return null
  return level === 'all' ? articles : articles.filter((a) => a.level === level)
}
