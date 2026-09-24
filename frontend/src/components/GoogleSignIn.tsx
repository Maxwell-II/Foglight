/**
 * Google 登录按钮（登录页、注册页共用）。
 *
 * 只在 GET /auth/providers 说 google: true 时才出现 —— 后端没配好 client id 时
 * 画出来就是一个点下去必然报错的按钮。探测失败也当没有，邮箱那条路永远在。
 *
 * 它是普通链接不是 fetch：OAuth 要整页跳到 Google 再跳回来，回调落地时写 cookie。
 * ⚠️ 国内直连打不开 accounts.google.com，所以它必须和邮箱表单**并排**，
 * 不能独占，也不能把邮箱藏进「其他方式」（design-brief §8）。
 */

import { useEffect, useState } from 'react'
import { GOOGLE_START_URL, getAuthProviders } from '../api/client'

export function useGoogleAvailable(): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    let cancelled = false
    getAuthProviders()
      .then((p) => {
        if (!cancelled) setAvailable(p.google === true)
      })
      .catch(() => {
        // 探测不到就不显示，邮箱登录不受影响
      })
    return () => {
      cancelled = true
    }
  }, [])
  return available
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  )
}

export function GoogleButton({ label = '用 Google 继续' }: { label?: string }) {
  return (
    <a className="google-btn" href={GOOGLE_START_URL}>
      <GoogleMark />
      {label}
    </a>
  )
}
