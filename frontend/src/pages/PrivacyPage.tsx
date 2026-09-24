/**
 * 隐私说明 `/privacy`（公开）。
 *
 * 发布清单（public-release.md §6 第 6 步）的必需项，也是 Google OAuth 同意屏的必填链接。
 *
 * ⚠️ 这页是承诺，不是文案：每一条都对着代码核过（2026-09-24）。改了下面这些地方，这页要跟着改：
 *   - 存了什么：models.py（User / AuthSession / ReadingSession / Mark）、google_oauth.py 只取 sub + email
 *   - 密码：services/password.py（scrypt）；登录凭证：deps.py 只存 token_hash，30 天（session_ttl_days）
 *   - 游客导出：routers/public.py 的 /public/export 只算不存
 *   - IP：nginx 默认访问日志；services/ratelimit.py 的计数只在内存里
 *   - 第三方：index.html 从 Google Fonts 加载字体
 *   - 备份：deploy/backup.sh 每天一份、KEEP=7
 */

import { Link } from 'react-router-dom'
import SupportContact from '../components/SupportContact'
import '../styles/login.css'

export default function PrivacyPage() {
  return (
    <div className="wrap login-wrap privacy-wrap">
      <Link className="brand" to="/">
        Foglight
      </Link>

      <h1 className="title login-title" style={{ marginTop: 32 }}>
        隐私说明
      </h1>
      <p className="login-sub dim">更新于 2026 年 9 月 24 日</p>

      <div className="login-card forgot-card privacy-card">
        <h2>不登录的时候</h2>
        <p>你的标记和阅读进度只存在这台浏览器里，不会上传。清掉浏览器数据，这些记录就没了。</p>
        <p>
          点「导出」时，这篇文章的标记会发到服务器生成复盘文本。生成完就丢掉，不保存。
        </p>

        <h2>注册或登录以后，服务器上存这些</h2>
        <ul>
          <li>你的邮箱。</li>
          <li>
            密码只存加密后的哈希值，谁都看不到原密码。用 Google 登录的账号没有密码。
          </li>
          <li>用 Google 登录时，只存 Google 账号的编号和邮箱，不存名字和头像。</li>
          <li>阅读记录：读过哪些文章、每一处标记的位置和文字、读到哪里。</li>
          <li>
            登录状态：浏览器里一个登录 cookie，30 天有效；服务器上只存它的哈希值。
          </li>
          <li>不登录时留下的本地标记，只有你点「导入」才会上传到账号里。</li>
        </ul>

        <h2>会看到你 IP 地址的地方</h2>
        <ul>
          <li>服务器的访问日志会记下 IP 和访问的页面，用来排查故障、防止滥用，定期自动删除。</li>
          <li>登录和注册的防刷限制会在内存里短暂记下 IP，服务重启就清空。</li>
          <li>页面字体从 Google Fonts 加载，所以 Google 也会看到你的 IP。</li>
        </ul>

        <h2>不做的事</h2>
        <p>
          没有广告，没有统计或追踪脚本。不出售、不分享你的数据。除了登录状态，不用 cookie
          记录你。
        </p>

        <h2>保存多久</h2>
        <p>阅读记录一直保留，直到你要求删除账号。</p>
        <p>
          服务器每天备份一次，保留最近 7 份。所以删除账号以后，数据最多还会在备份里留 7 天，之后彻底消失。
        </p>

        <h2>删除账号、要回数据、其他问题</h2>
        <p>
          联系：<SupportContact subject="Foglight 隐私 / 账号" />
          <br />
          <span className="dim">现在需要人工处理，请用注册时的邮箱联系。</span>
        </p>
      </div>

      <p className="auth-footnote">
        <Link to="/">← 回首页</Link>
      </p>
    </div>
  )
}
