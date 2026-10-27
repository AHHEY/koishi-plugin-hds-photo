'use strict'

const path = require('node:path')
const { Schema, h } = require('koishi')
const { createImageProvider, DEFAULT_PROMPT_TEMPLATE } = require('./lib/provider')
const { createRuntime } = require('./lib/runtime')
const { createStore } = require('./lib/store')
const { compatible, detectVersion } = require('./lib/protocol')

const ATTACH_KEY = Symbol.for('koishi-plugin-hds-photo.runtime')

exports.name = 'hds-photo'
exports.inject = { optional: ['interlude', 'database'] }

exports.Config = Schema.intersect([
  Schema.object({
    enabled: Schema.boolean().default(false).description('启用 AI 拍照；缺少 HDS 或配置错误时不会影响主叙事'),
    platform: Schema.string().default('onebot').description('私聊投递平台'),
    selfId: Schema.string().default('').description('机器人账号；留空不限制'),
    targetUserId: Schema.string().default('').description('允许接收照片的 QQ；留空跟随 HDS 全部私聊参与者'),
    storageDir: Schema.string().default('data/hds-photo').description('独立任务状态与图片目录，必须位于 Koishi 实例目录内'),
    contextTimeoutMs: Schema.natural().min(50).max(5000).default(500).description('主叙事读取拍照上下文的最长等待；超时自动按原请求继续'),
  }).description('运行边界'),
  Schema.object({
    endpoint: Schema.string().default('https://api.siliconflow.cn/v1/images/generations').description('OpenAI Images 兼容生图接口'),
    apiKey: Schema.string().role('secret').default('').description('生图 API Key'),
    model: Schema.string().default('Tongyi-MAI/Z-Image-Turbo').description('生图模型'),
    size: Schema.string().default('1024x1024').description('图片尺寸'),
    timeoutMs: Schema.natural().min(1000).default(180000).description('生图或图片下载超时（毫秒）'),
    maxImageMB: Schema.number().min(0.1).max(50).default(15).description('图片大小上限（MB）'),
    extraBody: Schema.string().role('textarea').default('{}').description('附加请求体 JSON；可覆盖默认 model/size/response_format'),
  }).description('在线生图'),
  Schema.object({
    appearanceProfile: Schema.string().role('textarea').default('年轻娇小的中国女大学生，黑色短发，右侧有奶油色迷你丝带，真实自然的日常生活外观').description('固定外观描述，不随剧情 Overlay 自动改变'),
    negativePrompt: Schema.string().role('textarea').default('动漫画风，插画，过度美颜，畸形手指，多余肢体，模糊，文字，水印，标志').description('不希望出现的画面内容'),
    photoStyle: Schema.string().role('textarea').default('真实自然的手机生活随拍，自然光，非摆拍，画面内容严格服从当前场景').description('照片风格；不使用叙事文风代替画面风格'),
    promptTemplate: Schema.string().role('textarea').default(DEFAULT_PROMPT_TEMPLATE).description('支持 {characterName} {appearance} {scene} {location} {style} {negativePrompt}'),
    referenceMode: Schema.union([
      Schema.const('none').description('不使用参考图'),
      Schema.const('single').description('image 字段发送单张 data URI'),
      Schema.const('array').description('image 字段发送 data URI 数组'),
    ]).default('none').description('参考图传递方式；需生图接口支持'),
    referenceImages: Schema.array(String).default([]).description('固定角色基准图本地路径；不会被自动删除或迭代覆盖'),
  }).description('角色与画面一致性'),
  Schema.object({
    proactiveEnabled: Schema.boolean().default(true).description('允许日常推进提出拍照；仍要求 HDS 本轮存在实际获准的主动私聊'),
    dailyLimit: Schema.natural().default(4).description('每日生成尝试上限，失败也计数；0 为不限'),
    maxPendingJobs: Schema.natural().min(1).max(10).default(2).description('最多同时等待的未完成任务'),
    requestCooldownMinutes: Schema.natural().default(2).description('用户明确索取照片的最小间隔'),
    proactiveCooldownMinutes: Schema.natural().default(180).description('日常主动拍照的最小间隔'),
    requestTtlHours: Schema.number().min(0.1).max(24).default(2).description('用户索取任务的有效小时数'),
    proactiveTtlHours: Schema.number().min(0.1).max(12).default(1).description('自主拍照任务的有效小时数'),
  }).description('频率与任务上限'),
])

function extraBody(value) {
  const parsed = JSON.parse(value || '{}')
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('extraBody 必须是 JSON 对象')
  return parsed
}

function storagePath(baseDir, configured) {
  const base = path.resolve(baseDir)
  const directory = path.resolve(base, configured)
  const relative = path.relative(base, directory)
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('storageDir 必须位于 Koishi 实例目录内')
  }
  return directory
}

exports.apply = function apply(ctx, config) {
  const logger = ctx.logger('hds-photo')
  let runtime

  ctx.command('interlude.photo.status', '查看 AI 拍照任务状态（管理员）').action(({ session }) => {
    try {
      if (!runtime) return 'AI 拍照未挂接'
      if (ctx.interlude?.canManageSession && !ctx.interlude.canManageSession(session)) return
      return JSON.stringify(runtime.status())
    } catch {
      return 'AI 拍照状态暂不可用'
    }
  })

  if (typeof ctx.inject !== 'function') {
    logger.warn('当前 Koishi 不支持服务注入，AI 拍照未挂接')
    return
  }

  ctx.inject(['interlude', 'database'], child => {
    try {
      const versionError = compatible(child.interlude, detectVersion(ctx.baseDir))
      if (versionError) {
        logger.warn(versionError)
        return
      }
      if (child.interlude[ATTACH_KEY]) {
        logger.warn('检测到重复 AI 拍照实例，已阻止重复挂接')
        return
      }
      if (config.enabled && (!config.endpoint.trim() || !config.apiKey.trim() || !config.model.trim())) {
        throw new Error('endpoint、apiKey 和 model 均须配置')
      }
      if (config.enabled && config.referenceMode !== 'none' && config.referenceImages.length && !config.appearanceProfile.trim()) {
        throw new Error('使用参考图时必须配置固定外观，禁止参考图单独决定人物身份')
      }
      const directory = storagePath(ctx.baseDir || process.cwd(), config.storageDir)
      const normalized = {
        ...config,
        extraBody: config.enabled ? extraBody(config.extraBody) : {},
        photoStyle: config.photoStyle || undefined,
        referenceRoot: path.join(directory, 'references'),
      }
      const store = createStore(directory, logger)
      const provider = createImageProvider(normalized, { logger })
      const current = createRuntime(child, normalized, { store, provider, logger, h })
      child.interlude[ATTACH_KEY] = current
      runtime = current
      child.on('dispose', () => {
        current.dispose()
        if (child.interlude[ATTACH_KEY] === current) delete child.interlude[ATTACH_KEY]
        if (runtime === current) runtime = undefined
      })
      logger.info(config.enabled
        ? 'AI 拍照已挂接；主叙事不等待生图，失败任务独立终止'
        : 'AI 拍照功能已停用；仅恢复尚未完成的结果回写，不接受新任务')
    } catch (error) {
      logger.warn('AI 拍照初始化失败，已保持原主叙事不变：%s', error?.code || error?.name || '初始化错误')
    }
  })
}
