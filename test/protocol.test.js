'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { capability, ownedIntent, parsePhotoIntent, safeError } = require('../lib/protocol')

test('区分普通拍照与用户明确索取', () => {
  const normal = parsePhotoIntent({ mode: 'search', query: 'photo: 在宿舍书桌前写作业', purpose: '分享当下' })
  const requested = parsePhotoIntent({ mode: 'search', query: 'photo-request: 在阳台给植物浇水', purpose: '用户索取' })
  assert.equal(normal.requested, false)
  assert.equal(requested.requested, true)
  assert.equal(normal.timing, 'deferred')
})

test('无效意图被消费但不创建任务，其他插件命名空间不受影响', () => {
  assert.equal(ownedIntent({ mode: 'search', query: 'photo:' }), true)
  assert.equal(parsePhotoIntent({ mode: 'search', query: 'photo:', purpose: '无场景' }), null)
  assert.equal(ownedIntent({ mode: 'search', query: 'bili: 摄影' }), false)
  assert.equal(ownedIntent({ mode: 'visit', url: 'https://example.com' }), false)
})

test('dailyLimit 为 0 时能力说明正确显示不限次', () => {
  assert.match(capability({ dailyLimit: 0, proactiveEnabled: false }), /每日次数不限/)
})

test('错误摘要不会回显密钥或远程内容', () => {
  const message = safeError(new Error('secret-key and signed-url'))
  assert.doesNotMatch(message, /secret-key|signed-url/)
})
