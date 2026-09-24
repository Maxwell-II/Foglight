/**
 * 路由守卫（Wave 3 A2）。自包含：不改 App.tsx（那是书籍线的文件），
 * 由规划方在合并时把需要保护的路由包进来。
 *
 *   <RequireAuth><LibraryPage /></RequireAuth>
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { LOGIN_PATH, probeAuth, type AuthStatus } from '../lib/auth'
import type { MeDto } from '../api/client'
import AppActions from './AppActions'
import '../styles/login.css'

/**
 * 登录用户。守卫本来就为了判断登录态打了一次 /auth/me，之前只留下三态里的
 * status、把 user 丢掉了；侧栏要显示用户名，与其再打一次，不如把这次的结果发下去。
 *
 * 只在 authed 分支下有值 —— 其余分支根本不渲染 children。
 */
const AuthUserContext = createContext<MeDto | null>(null)

export function useAuthUser(): MeDto | null {
  return useContext(AuthUserContext)
}

export default function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [status, setStatus] = useState<AuthStatus>('checking')
  const [user, setUser] = useState<MeDto | null>(null)

  useEffect(() => {
    let cancelled = false
    probeAuth().then((probe) => {
      if (cancelled) return
      setStatus(probe.status)
      setUser(probe.user)
    })
    return () => {
      cancelled = true
    }
    // 只在挂载时问一次：守卫包在路由外层，页面之间切换不会重挂，
    // 每次切页都打一次 /auth/me 是白花钱。会话失效由各接口自己的 401 暴露。
  }, [])

  if (status === 'checking') {
    // ⚠️ 这一支是三态的全部意义所在：既不渲染内容，**也不渲染登录页**。
    //    渲染登录页的话，硬刷新首页会闪一下登录表单再跳回来。
    // 主题按钮照常渲染：它和登录状态无关，探测这几十毫秒里让它闪掉才难看。
    return (
      <>
        <AppActions />
        <div className="auth-checking" role="status" aria-busy="true" aria-label="正在确认登录状态" />
      </>
    )
  }

  if (status === 'anonymous') {
    // 记住原地址，登录成功后跳回去。用字符串而不是整个 location 对象 ——
    // history.state 要能被结构化克隆。
    return (
      <Navigate to={LOGIN_PATH} state={{ from: location.pathname + location.search }} replace />
    )
  }

  // 主题和退出按钮不再挂在右上角：它们进了 <AppShell> 的侧栏页脚。
  // 'checking' 分支里那个 <AppActions> 留着 —— 那时候壳还没渲染。
  return <AuthUserContext.Provider value={user}>{children}</AuthUserContext.Provider>
}
