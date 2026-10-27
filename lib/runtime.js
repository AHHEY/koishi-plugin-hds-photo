'use strict'

const fs = require('node:fs')
const {
  SOURCE,
  capability,
  hash,
  ownedIntent,
  parsePhotoIntent,
  safeError,
  stamp,
  text,
} = require('./protocol')

const TERMINAL = new Set(['failed', 'cancelled', 'delivered', 'generation-unknown', 'delivery-unknown'])
const RECORDABLE = new Set(TERMINAL)

function localDay(date) {
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function fileUrl(absolutePath) {
  const normalized = String(absolutePath || '').replace(/\\/g, '/').replace(/^\/+/, '')
  return `file:///${normalized}`
}

function createRuntime(ctx, config, options) {
  const service = ctx.interlude
  const store = options.store
  const state = store.state
  const provider = options.provider
  const logger = options.logger || ctx.logger('hds-photo')
  const clock = options.now || (() => new Date())
  const autoSchedule = options.autoSchedule !== false
  const setTimer = options.setTimeout || setTimeout
  const clearTimer = options.clearTimeout || clearTimeout
  const h = options.h
  let disposed = false
  let busy = false
  let timer
  const pendingCaptures = new Set()

  const active = () => !disposed && config.enabled === true && !state.paused && !state.persistenceFault
  const database = () => ctx.database || service.ctx?.database
  const rows = (table, query, modifier) => database().get(table, query, modifier)

  function inScope(story, participant) {
    if (!story || !participant || story.status !== 'active' || participant.status !== 'active') return false
    if (story.platform !== config.platform || participant.platform !== config.platform) return false
    if (config.selfId && (String(story.selfId) !== String(config.selfId) || String(participant.selfId) !== String(config.selfId))) return false
    if (String(participant.storyId) !== String(story.id)) return false
    if (config.targetUserId && String(participant.userId) !== String(config.targetUserId)) return false
    return true
  }

  function requestScope(request) {
    return request && !request.groupContext && inScope(request.story, request.participant)
  }

  function counters() {
    const day = localDay(clock())
    if (state.counters.day !== day) state.counters = { day, attempts: 0, delivered: 0 }
    state.counters.attempts ||= 0
    state.counters.delivered ||= 0
    return state.counters
  }

  function save() {
    return store.save()
  }

  function hasRecordableJob() {
    return !state.persistenceFault && state.jobs.some(job =>
      !job.recordedAt && !job.recordSkipped && TERMINAL.has(job.status))
  }

  function schedule(delay = 0) {
    if (!autoSchedule || disposed || timer || (!active() && !hasRecordableJob())) return
    timer = setTimer(() => {
      timer = undefined
      void tick()
    }, Math.max(0, delay))
    timer.unref?.()
  }

  function nextJob(includeFuture = false) {
    const now = clock().getTime()
    const runnable = state.jobs.find(job => {
      if (job.recordedAt || job.recordSkipped) return false
      if (!TERMINAL.has(job.status) && !active()) return false
      if (!includeFuture && (job.notBefore || 0) > now) return false
      if (TERMINAL.has(job.status)) return RECORDABLE.has(job.status)
      return ['pending', 'generated'].includes(job.status)
    })
    return runnable
  }

  function nextWakeDelay() {
    const now = clock().getTime()
    let earliest = Infinity
    for (const job of state.jobs) {
      if (job.recordedAt || job.recordSkipped) continue
      if (!TERMINAL.has(job.status) && (!active() || !['pending', 'generated'].includes(job.status))) continue
      earliest = Math.min(earliest, Math.max(0, (job.notBefore || 0) - now))
    }
    return earliest === Infinity ? null : earliest
  }

  async function tick() {
    if (busy || disposed) return
    const job = nextJob()
    if (!job) {
      const delay = nextWakeDelay()
      if (delay !== null) schedule(delay)
      return
    }
    busy = true
    try {
      await processJob(job)
    } catch (error) {
      logger.warn('拍照任务未继续执行：%s', safeError(error))
    } finally {
      busy = false
      const delay = nextWakeDelay()
      if (delay !== null) schedule(delay)
    }
  }

  async function sourceValid(job, forRecord = false) {
    const story = (await rows('interlude_story', { id: job.storyId }))[0]
    if (!story || stamp(story.createdAt) !== job.storyCreatedAt) return null
    if (!forRecord && story.status !== 'active') return null
    const participant = (await rows('interlude_participant', { id: job.participantId, storyId: job.storyId }))[0]
    if (!participant) return null
    if (!forRecord) {
      if (!inScope(story, participant)) return null
      if (service.canHandleStory && !service.canHandleStory(story)) return null
      if (service.canHandleParticipant && !service.canHandleParticipant(participant)) return null
    }
    const source = (await rows('interlude_script_entry', {
      id: job.sourceEntryId,
      storyId: job.storyId,
      kind: 'script',
    }))[0]
    if (!source || hash(source.content) !== job.sourceHash) return null
    if (String(source.participantId || '') !== String(job.participantId)) return null
    if (!forRecord && !job.requested) {
      const latestUser = (await rows('interlude_script_entry', {
        storyId: job.storyId,
        participantId: job.participantId,
        kind: 'user-message',
      }, { limit: 1, sort: { id: 'desc' } }))[0]
      if (latestUser && latestUser.id > (job.lastUserEntryId || 0)) return null
    }
    return { story, participant, source }
  }

  async function enrichRequest(request) {
    if (!active() || !requestScope(request)) return request
    let observations = []
    try {
      const cutoff = new Date(clock().getTime() - 24 * 3600000)
      const found = await rows('interlude_script_entry', {
        storyId: request.story.id,
        participantId: request.participant.id,
        kind: 'photo-observation',
        metadata: { source: SOURCE },
        occurredAt: { $gte: cutoff },
      }, { limit: 20, sort: { id: 'desc' } })
      observations = found.filter(row => row.metadata?.final === true).slice(0, 3).reverse()
    } catch {
      observations = []
    }
    const originalWorld = request.story.setting.world || ''
    return {
      ...request,
      story: {
        ...request.story,
        setting: {
          ...request.story.setting,
          world: originalWorld + '\n\n' + capability({
            ...config,
            proactiveEnabled: config.proactiveEnabled && service.config?.runtime?.allowProactiveMessages === true,
          }),
        },
      },
      contractFeatures: { ...request.contractFeatures, webObservation: true },
      writingOptions: {
        ...request.writingOptions,
        browserMode: request.writingOptions?.browserMode === 'allow-immediate' ? 'allow-immediate' : 'deferred-only',
      },
      webContext: [...(request.webContext || []), ...observations.map(row => ({
        id: row.id,
        storyId: row.storyId,
        participantId: row.participantId,
        intentId: null,
        mode: 'visit',
        query: '',
        url: '',
        title: 'AI 拍照工具结果（非网页）',
        excerpt: row.content,
        summary: row.content,
        status: row.metadata.status === 'delivered' ? 'success' : 'failed',
        accessedAt: new Date(row.occurredAt),
        createdAt: new Date(row.createdAt),
      }))].slice(-4),
    }
  }

  const originalNarrator = service.getNarrator()
  const decorated = Object.create(originalNarrator)
  decorated.decide = async request => {
    let enriched = request
    let contextTimer
    try {
      const timeout = new Promise(resolve => {
        contextTimer = setTimer(() => resolve(null), Math.max(50, config.contextTimeoutMs || 500))
        contextTimer?.unref?.()
      })
      const candidate = await Promise.race([enrichRequest(request), timeout])
      if (candidate === null) logger.warn('拍照能力上下文读取超时，已按原请求继续主叙事')
      else enriched = candidate
    } catch (error) {
      logger.warn('拍照能力上下文不可用，已按原请求继续主叙事：%s', safeError(error))
      enriched = request
    } finally {
      if (contextTimer) clearTimer(contextTimer)
    }
    const result = await originalNarrator.decide.call(originalNarrator, enriched)
    try {
      if (!result || !Array.isArray(result.browserIntents)) return result
      return {
        ...result,
        browserIntents: result.browserIntents.map(draft => ownedIntent(draft) ? { ...draft, timing: 'deferred' } : draft),
      }
    } catch {
      return result
    }
  }

  const originalPersist = service.persistDecision
  const persist = async function (...args) {
    let actualArgs = args
    let drafts = []
    try {
      const decision = args[2]
      const all = Array.isArray(decision?.browserIntents) ? decision.browserIntents : []
      drafts = all.map(parsePhotoIntent).filter(Boolean).slice(0, 1)
      if (all.some(ownedIntent)) {
        const copy = args.slice()
        copy[2] = { ...decision, browserIntents: all.filter(draft => !ownedIntent(draft)) }
        actualArgs = copy
      }
    } catch (error) {
      actualArgs = args
      drafts = []
      logger.warn('拍照意图解析失败，已按原决策继续主叙事：%s', safeError(error))
    }

    const result = await originalPersist.apply(this, actualArgs)
    try {
      if (drafts.length && active()) {
        const pending = Promise.resolve()
          .then(() => capture(args, drafts[0], result))
          .catch(error => {
            logger.warn('拍照意图未保存，不影响已提交的主叙事：%s', safeError(error))
          })
        pendingCaptures.add(pending)
        void pending.finally(() => pendingCaptures.delete(pending))
      }
    } catch (error) {
      logger.warn('拍照意图调度失败，不影响已提交的主叙事：%s', safeError(error))
    }
    return result
  }
  try {
    service.setNarrator(decorated)
    service.persistDecision = persist
  } catch (error) {
    try { if (service.getNarrator() === decorated) service.setNarrator(originalNarrator) } catch {}
    try { if (service.persistDecision === persist) service.persistDecision = originalPersist } catch {}
    throw error
  }

  function pruneJobs() {
    const excess = state.jobs.length - 300
    if (excess <= 0) return
    let remaining = excess
    for (let index = 0; index < state.jobs.length && remaining > 0;) {
      const job = state.jobs[index]
      if (job.recordedAt || job.recordSkipped) {
        state.jobs.splice(index, 1)
        remaining -= 1
      } else {
        index += 1
      }
    }
  }

  async function capture(args, draft, persisted) {
    if (!active()) return
    const [story, participant, decision, , now, permitMessages, phase] = args
    if (!inScope(story, participant) || !decision?.script || permitMessages !== true) return
    if (phase !== 'user-message') {
      if (!config.proactiveEnabled || draft.requested) return
      if (service.config?.runtime?.allowProactiveMessages !== true) return
      const visible = Array.isArray(persisted?.messages) && persisted.messages.some(message =>
        String(message.participantId || '') === String(participant.id) && text(message.content, 1))
      if (!visible) return
    }
    const latestUser = (await rows('interlude_script_entry', {
      storyId: story.id,
      participantId: participant.id,
      kind: 'user-message',
    }, { limit: 1, sort: { id: 'desc' } }))[0]
    const committed = (await rows('interlude_script_entry', {
      storyId: story.id,
      kind: 'script',
      createdAt: now,
    }, { limit: 8, sort: { id: 'desc' } })).find(row => String(row.participantId || '') === String(participant.id))
    if (!committed?.content) return
    const sourceHash = hash(committed.content)
    const id = hash(`${story.id}:${committed.id}:${draft.requested}:${draft.scene}:${draft.purpose}`).slice(0, 32)
    if (state.jobs.some(job => job.id === id)) return
    const activeJobs = state.jobs.filter(job => !job.recordedAt && !TERMINAL.has(job.status)).length
    if (activeJobs >= Math.max(1, config.maxPendingJobs || 2)) return
    const createdAt = clock().getTime()
    state.jobs.push({
      id,
      storyId: story.id,
      storyCreatedAt: stamp(story.createdAt),
      participantId: participant.id,
      platform: participant.platform,
      selfId: String(participant.selfId || story.selfId || ''),
      userId: String(participant.userId),
      sourceEntryId: committed.id,
      sourceHash,
      lastUserEntryId: latestUser?.id || 0,
      scene: draft.scene,
      purpose: draft.purpose,
      requested: draft.requested,
      phase,
      status: 'pending',
      attempts: 0,
      createdAt,
      updatedAt: createdAt,
      notBefore: 0,
    })
    pruneJobs()
    if (save()) schedule(0)
  }

  function mark(job, status, error) {
    job.status = status
    job.updatedAt = clock().getTime()
    if (error) job.lastError = safeError(error)
    save()
  }

  async function generate(job) {
    if (service.getDesktopRuntimePhase() === 'paused') {
      job.notBefore = clock().getTime() + 60000
      save()
      return
    }
    const ttlHours = job.requested ? config.requestTtlHours : config.proactiveTtlHours
    if (clock().getTime() - job.createdAt > ttlHours * 3600000) {
      mark(job, 'cancelled')
      return
    }
    const counts = counters()
    if (config.dailyLimit > 0 && counts.attempts >= config.dailyLimit) {
      mark(job, 'cancelled')
      return
    }
    const lastAt = job.requested ? state.lastRequestAt : state.lastProactiveAt
    const cooldown = (job.requested ? config.requestCooldownMinutes : config.proactiveCooldownMinutes) * 60000
    const wait = lastAt + cooldown - clock().getTime()
    if (wait > 0) {
      job.notBefore = clock().getTime() + wait
      save()
      return
    }
    const valid = await sourceValid(job)
    if (!valid) {
      mark(job, 'cancelled')
      return
    }

    job.status = 'generating'
    job.attempts += 1
    job.updatedAt = clock().getTime()
    counts.attempts += 1
    state.lastAttemptAt = clock().getTime()
    if (job.requested) state.lastRequestAt = clock().getTime()
    else state.lastProactiveAt = clock().getTime()
    if (!save()) return

    let image
    try {
      image = await provider.generate({ scene: job.scene, purpose: job.purpose, story: valid.story })
      const assetFile = store.writeAsset(job, image)
      job.assetFile = assetFile
      job.assetHash = image.hash
      job.mimeType = image.mimeType
      job.status = 'generated'
      job.updatedAt = clock().getTime()
      if (!save()) return
    } catch (error) {
      mark(job, 'failed', error)
      return
    }
  }

  function findBot(job) {
    return (ctx.bots || []).find(bot => bot.platform === job.platform && String(bot.selfId) === String(job.selfId))
  }

  async function sendImage(job, filePath) {
    const source = fileUrl(filePath)
    if (typeof service.desktopOnebotActionHandler === 'function') {
      const outcome = await service.desktopOnebotActionHandler({
        accountKey: `onebot:${job.selfId}`,
        action: 'send_private_msg',
        params: {
          user_id: job.userId,
          message: `[CQ:image,file=${source}]`,
          auto_escape: false,
        },
      })
      if (!outcome?.ok) throw Object.assign(new Error('photo-delivery-failed'), { code: 'photo-delivery-failed' })
      return outcome
    }
    const bot = findBot(job)
    if (!bot) throw Object.assign(new Error('photo-bot-offline'), { code: 'photo-bot-offline' })
    return bot.sendPrivateMessage(job.userId, h('img', { src: source }))
  }

  async function deliver(job) {
    if (service.getDesktopRuntimePhase() === 'paused') {
      job.notBefore = clock().getTime() + 60000
      save()
      return
    }
    const valid = await sourceValid(job)
    if (!valid) {
      mark(job, 'cancelled')
      return
    }
    const filePath = store.assetPath(job)
    if (!filePath || !fs.existsSync(filePath)) {
      mark(job, 'failed')
      return
    }
    if (!findBot(job) && typeof service.desktopOnebotActionHandler !== 'function') {
      job.notBefore = clock().getTime() + 60000
      save()
      return
    }
    job.status = 'sending'
    job.updatedAt = clock().getTime()
    if (!save()) return
    try {
      const receipt = await sendImage(job, filePath)
      job.messageReceipt = typeof receipt === 'string'
        ? receipt
        : Array.isArray(receipt)
          ? String(receipt[0] || '')
          : receipt?.messageId || receipt?.message_id || ''
      job.status = 'delivered'
      job.deliveredAt = clock().getTime()
      job.updatedAt = clock().getTime()
      counters().delivered += 1
      if (!save()) {
        job.status = 'delivery-unknown'
        return
      }
    } catch (error) {
      mark(job, 'delivery-unknown', error)
    }
  }

  function observationContent(job) {
    const labels = {
      delivered: '图片已经由平台接受并投递；这表示照片已发送，不表示对方已经查看。',
      failed: '拍照工具未能生成或准备图片；没有执行成功投递。',
      cancelled: '拍照意图已取消或过期；没有执行成功投递。',
      'generation-unknown': '生成过程中断，结果未知；不会自动重新生成。',
      'delivery-unknown': '图片投递结果未知；不会自动重发，不能宣称对方已收到。',
    }
    return `[拍照工具] ${labels[job.status] || '拍照动作未成功完成。'} 原始场景意图：${job.scene}`
  }

  async function appendObservation(job) {
    const prior = (await rows('interlude_script_entry', {
      storyId: job.storyId,
      kind: 'photo-observation',
      metadata: { source: SOURCE, photoJobId: job.id, event: 'observation' },
    }, { limit: 1 }))[0]
    if (prior) return prior
    const now = clock()
    return service.appendEntry(job.storyId, {
      kind: 'photo-observation',
      actor: 'system',
      content: observationContent(job),
      occurredAt: now.toISOString(),
      metadata: {
        source: SOURCE,
        photoJobId: job.id,
        sourceEntryId: job.sourceEntryId,
        sourceScriptHash: job.sourceHash,
        action: 'photo',
        event: 'observation',
        final: true,
        status: job.status,
        requested: job.requested,
        assetHash: job.assetHash || '',
        mimeType: job.mimeType || '',
      },
    }, now, job.participantId)
  }

  async function appendDeliveredAction(job) {
    if (job.status !== 'delivered') return null
    const prior = (await rows('interlude_script_entry', {
      storyId: job.storyId,
      kind: 'character-platform-action',
      metadata: { source: SOURCE, photoJobId: job.id, event: 'delivered-action' },
    }, { limit: 1 }))[0]
    if (prior) return prior
    const now = clock()
    return service.appendEntry(job.storyId, {
      kind: 'character-platform-action',
      actor: 'character',
      content: '主角向当前私聊对象发送了一张由 AI 生成的照片。',
      occurredAt: now.toISOString(),
      metadata: {
        source: SOURCE,
        photoJobId: job.id,
        sourceEntryId: job.sourceEntryId,
        sourceScriptHash: job.sourceHash,
        action: 'generated-photo',
        event: 'delivered-action',
        status: 'delivered',
        assetHash: job.assetHash,
        mimeType: job.mimeType,
        messageReceipt: job.messageReceipt || '',
      },
    }, now, job.participantId)
  }

  async function record(job) {
    if (job.recordedAt || job.recordSkipped || !TERMINAL.has(job.status)) return
    try {
      await service.serial(job.storyId, async () => {
        if (job.recordedAt || job.recordSkipped) return
        const valid = await sourceValid(job, true)
        if (!valid) {
          job.recordSkipped = 'source-invalid'
          job.updatedAt = clock().getTime()
          save()
          return
        }
        await appendObservation(job)
        await appendDeliveredAction(job)
        job.recordedAt = clock().getTime()
        job.updatedAt = clock().getTime()
        save()
      })
    } catch (error) {
      job.notBefore = clock().getTime() + 60000
      job.lastError = safeError(error)
      save()
      logger.warn('拍照结果暂未写入 HDS，将稍后重试；不会重复生成或发送：%s', safeError(error))
    }
  }

  async function processJob(job) {
    if (!job || job.recordedAt || job.recordSkipped) return
    if (TERMINAL.has(job.status)) {
      await record(job)
      return
    }
    if (!active()) return
    try {
      if (job.status === 'pending') await generate(job)
      if (job.status === 'generated') await deliver(job)
      if (TERMINAL.has(job.status)) await record(job)
    } catch (error) {
      if (job.status === 'sending') mark(job, 'delivery-unknown', error)
      else if (job.status === 'generating') mark(job, 'failed', error)
      else mark(job, 'failed', error)
      await record(job)
    }
  }

  async function drain(limit = 30) {
    let count = 0
    while (count < limit) {
      const job = nextJob()
      if (!job) break
      await processJob(job)
      count += 1
      if (job.notBefore > clock().getTime() && !job.recordedAt && !TERMINAL.has(job.status)) break
    }
    return count
  }

  function normalizeInterruptedJobs() {
    let changed = false
    for (const job of state.jobs) {
      if (job.status === 'generating') {
        job.status = 'generation-unknown'
        job.lastError = '生成过程中插件重载，结果未知'
        changed = true
      } else if (job.status === 'sending') {
        job.status = 'delivery-unknown'
        job.lastError = '投递过程中插件重载，结果未知'
        changed = true
      }
    }
    if (changed) save()
  }

  function status() {
    const counts = {}
    for (const job of state.jobs) counts[job.status] = (counts[job.status] || 0) + 1
    return {
      active: active(),
      paused: state.paused,
      persistenceFault: state.persistenceFault,
      jobs: counts,
      today: counters(),
    }
  }

  async function flushCaptures() {
    while (pendingCaptures.size) await Promise.all([...pendingCaptures])
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (timer) clearTimer(timer)
    timer = undefined
    if (service.getNarrator() === decorated) service.setNarrator(originalNarrator)
    if (service.persistDecision === persist) service.persistDecision = originalPersist
  }

  try {
    normalizeInterruptedJobs()
    schedule(100)
  } catch (error) {
    dispose()
    throw error
  }

  return { status, dispose, drain, tick, nextWakeDelay, flushCaptures, processJob, capture, enrichRequest }
}

module.exports = { createRuntime, fileUrl, TERMINAL }
