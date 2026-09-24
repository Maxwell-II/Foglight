/**
 * 路由守卫（Wave 3 A2）。在 App.tsx 里作为无路径的 layout route 挂一层：
 *
 *   <Route element={<RequireAuth><Outlet /></RequireAuth>}> …要登录的页面… </Route>
 *
 * 公开页面（落地页、/try、登录注册）**不能**包进来 —— 它们要判断登录态时
 * 自己调一次 probeAuth()。
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { LOGIN_PATH, probeAuth, type AuthStatus } from '../lib/auth'
import type { MeDto } from '../api/client'
import AppActions from './AppActions'
import GuestImportPrompt from './GuestImportPrompt'
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

/**
 * 账号里的阅读数据在守卫这一层被改过几次（目前只有游客标记迁移）。
 * <AppShell> 把它放进拉列表的依赖里：迁移成功后文章库的「读过 / 标了 N 处」要跟着变。
 * 迁移弹窗挂在守卫这层、壳的外面，所以不能直接调 useShellData().reload()。
 */
const DataVersionContext = createContext(0)

export function useDataVersion(): number {
  return useContext(DataVersionContext)
}

export default function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation()
  const [status, setStatus] = useState<AuthStatus>('checking')
  const [user, setUser] = useState<MeDto | null>(null)
  const [dataVersion, setDataVersion] = useState(0)
  const bumpData = useCallback(() => setDataVersion((n) => n + 1), [])

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
  return (
    <AuthUserContext.Provider value={user}>
      <DataVersionContext.Provider value={dataVersion}>
        {children}
        {/* 进入已登录区域时问一次本地标记要不要带进账号。没有本地标记时它什么都不渲染 */}
        <GuestImportPrompt onImported={bumpData} />
      </DataVersionContext.Provider>
    </AuthUserContext.Provider>
  )
}
