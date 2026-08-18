import { useState } from 'react'
import { getStoredTheme, nextTheme, setTheme, type Theme } from '../lib/theme'

const LABELS: Record<Theme, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
}

const ICONS: Record<Theme, string> = {
  system: '🖥',
  light: '☀',
  dark: '☾',
}

/** 固定右上角的三态主题按钮。挂在 App.tsx 顶层，不属于任何 page 组件。 */
export default function ThemeToggle() {
  const [theme, setThemeState] = useState<Theme>(getStoredTheme)

  const cycle = () => {
    const next = nextTheme(theme)
    setTheme(next)
    setThemeState(next)
  }

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={cycle}
      title={`主题：${LABELS[theme]}（点击切换）`}
      aria-label={`切换主题，当前：${LABELS[theme]}`}
    >
      {ICONS[theme]}
    </button>
  )
}
