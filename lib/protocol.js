'use strict'

const crypto = require('node:crypto')

const SOURCE = 'hds-photo'
const SUPPORTED_HDS = '1.0.1-rc57'
const OWN_INTENT = /^photo(?:-request)?\s*:/i
const PARSE_INTENT = /^photo(-request)?\s*:\s*([\s\S]+)$/i

function text(value, limit = 500) {
  return Array.from(String(value ?? '').trim()).slice(0, limit).join('')
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function stamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(+date) ? date.toISOString() : ''
}

function ownedIntent(draft) {
  return draft?.mode === 'search' && OWN_INTENT.test(String(draft.query || '').trim())
}

function parsePhotoIntent(draft) {
  if (!ownedIntent(draft)) return null
  const purpose = text(draft.purpose, 240)
  const match = PARSE_INTENT.exec(String(draft.query).trim())
  const scene = text(match?.[2], 500)
  if (!purpose || !scene || scene.length < 2) return null
  return {
    scene,
    purpose,
    requested: Boolean(match[1]),
    timing: 'deferred',
  }
}

function capability(config) {
  const remaining = Number.isInteger(config.dailyLimit) && config.dailyLimit > 0
    ? `每日最多尝试 ${config.dailyLimit} 次（失败也计数）`
    : '每日次数不限'
  return `【可选的 AI 拍照生活能力，真实工具边界】
你可以在当前真实生活场景已经提供充分动机时，提出拍一张照片给当前私聊对象看；不想拍、没有合适场景时不提出，绝不是每回合任务。${remaining}。
在本回合原有 JSON 的 browserIntents 中最多提出一个：{"mode":"search","query":"photo: 只描述当前剧情已经发生的地点、动作、姿态和可见环境","purpose":"为什么此刻想分享照片","timing":"deferred"}。
只有当前用户明确索要照片时才把前缀写成 photo-request:，其余情况使用 photo:。场景描述不能编造尚未发生的新剧情，不得要求图片呈现隐私信息、账号凭据或其他参与者的私聊。
拍照意图只是未来动作，不代表已经拍摄、生成或发送。结果返回前，正文只能说打算、准备或尝试，禁止宣称照片已拍好、已发出或对方已看到。图片由生成模型依据固定外观与场景描述生成，可能失败或与预期不符；不得把图中偶然出现的额外人物、物品或事件写成世界事实。
实际结果会以来源为 ${SOURCE} 的观察记录出现。只有状态为 delivered 才表示平台已接受图片；failed、cancelled、generation-unknown、delivery-unknown 都不是成功。失败时不必机械道歉，也不要由你伪造一个成功结果。
${config.proactiveEnabled ? '日常推进时可以低频主动拍照，但仍须通过 HDS 原有主动消息许可，并由本轮实际可见消息门控确认。' : '目前只允许响应用户消息回合中的拍照意图，不要在纯后台推进中提出。'}`
}

function compatible(service, version) {
  if (version !== SUPPORTED_HDS) return `仅支持 HDS ${SUPPORTED_HDS}；检测到 ${version || '版本未知'}，未挂接`
  for (const name of ['getNarrator', 'setNarrator', 'persistDecision', 'appendEntry', 'serial', 'getDesktopRuntimePhase']) {
    if (typeof service?.[name] !== 'function') return `HDS 缺少 ${name} 接口，未挂接`
  }
  if (typeof service.getNarrator()?.decide !== 'function') return 'HDS 主叙事接口不可用，未挂接'
  return ''
}

function detectVersion(baseDir) {
  try {
    const file = require.resolve('koishi-plugin-hds-interlude/package.json', { paths: [baseDir || process.cwd(), __dirname] })
    return require(file).version
  } catch {
    return ''
  }
}

function safeError(error) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '请求超时或已取消'
  if (typeof error?.code === 'string' && /^[A-Z0-9_-]{2,40}$/i.test(error.code)) return `拍照工具未完成（${error.code}）`
  return '拍照工具未完成；请检查网络、接口、存储和投递状态'
}

module.exports = {
  SOURCE,
  SUPPORTED_HDS,
  capability,
  compatible,
  detectVersion,
  hash,
  ownedIntent,
  parsePhotoIntent,
  safeError,
  stamp,
  text,
}
