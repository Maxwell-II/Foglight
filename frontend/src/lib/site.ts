/**
 * 对外文案里「还会换」的那几样，集中放这里，改的时候不用满仓库找。
 */

/** 落地页 tagline。候选见 public-release.md §5（还有「不必每个词都懂」），定稿前随时可换 */
export const TAGLINE = '读英文原文，读完立刻复盘'

/**
 * 落地页首推的那篇。按标题认而不是按 id：本地和线上是分别入库的，id 对不上。
 * 公开库里找不到（被撤下、改了标题）就退回「第一篇 150–400 词的短文」，不会空屏。
 */
export const FEATURED_TITLE = 'The Only Way to Respond to Life'

/**
 * 人工联系方式：/forgot 收不到验证码时的兜底、/privacy 的删号和数据请求。
 * 空字符串 = 还没定：/forgot 显示「联系方式即将公布」，不留一个点了没反应的死链接。
 * 填邮箱会渲染成 mailto 链接，填别的（微信号之类）原样显示。
 *
 * ⚠️ 只填转发地址，不填私人邮箱：这个值会打进前端包、进公开仓库。support@ 由 Cloudflare
 *    Email Routing 转发到私人邮箱，回信用哪个邮箱由收件人自己决定（2026-09-28）。
 */
export const SUPPORT_CONTACT: string = 'support@rnuxay.xyz'
