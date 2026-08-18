/**
 * 三态主题（W3，docs/work-packets-wave2.md §3.3）。
 *
 * 'system' 时不写 data-theme 属性，靠 index.css 里的
 * `@media (prefers-color-scheme: dark)` 兜底；'light' / 'dark' 显式覆盖。
 * 防白闪脚本内联在 frontend/index.html 的 <head> 里，在 React 挂载前
 * 就用同一个 localStorage key 把 data-theme 设好，这里只是运行时之后的切换逻辑。
 */

export type Theme = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'reading.theme'
const CYCLE: Theme[] = ['system', 'light', 'dark']

export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch {
    // localStorage 不可用（隐私模式等）时退回默认
  }
  return 'system'
}

export function applyTheme(theme: Theme): void {
  if (theme === 'system') {
    delete document.documentElement.dataset.theme
  } else {
    document.documentElement.dataset.theme = theme
  }
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // 存不进去就只在本次会话内生效
  }
  applyTheme(theme)
}

export function nextTheme(current: Theme): Theme {
  return CYCLE[(CYCLE.indexOf(current) + 1) % CYCLE.length]
}
