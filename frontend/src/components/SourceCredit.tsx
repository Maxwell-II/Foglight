/**
 * meta 行尾的出处链接：「 · 原文 zenhabits.net」。
 *
 * 公开库的每篇都要能链回原文 —— 公有领域的是礼貌，CC BY 的是授权条件
 * （Global Voices 这类来源不带链接就是违约），作者授权的是答应过作者的事。落地页页脚「每篇都注明出处」靠的就是这里。
 * 没有 source_url 的（粘贴导入、书页）不显示，不编一个出来。
 */

export default function SourceCredit({ url, name }: { url: string | null; name?: string | null }) {
  if (!url) return null
  let label = name
  if (!label) {
    try {
      label = new URL(url).hostname
    } catch {
      return null
    }
  }
  return (
    <>
      {' · 原文 '}
      <a href={url} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    </>
  )
}
