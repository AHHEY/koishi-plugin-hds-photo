'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')

const DEFAULT_PROMPT_TEMPLATE = [
  'Character: {characterName}.',
  'Appearance: {appearance}.',
  'Scene: {scene}.',
  'Location: {location}.',
  'Style: {style}.',
  'Avoid: {negativePrompt}.',
].join('\n')
const MAX_SCENE_LENGTH = 2000
const DEFAULT_MAX_IMAGE_MB = 20
const DEFAULT_TIMEOUT_MS = 60000

class ImageProviderError extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'ImageProviderError'
  }
}

function detectImage(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' }
  }
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) {
    return { mimeType: 'image/gif', extension: 'gif' }
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', extension: 'webp' }
  }
  return null
}

function imageResult(buffer, maxBytes) {
  if (buffer.length > maxBytes) throw new ImageProviderError('Generated image exceeds image size limit')
  const type = detectImage(buffer)
  if (!type) throw new ImageProviderError('Image provider response is not a supported image')
  return {
    data: buffer,
    ...type,
    hash: crypto.createHash('sha256').update(buffer).digest('hex'),
  }
}

function makePrompt(config, input) {
  const setting = input.story && input.story.setting
  const character = setting && setting.character
  const values = {
    characterName: character && character.name,
    appearance: (character && character.appearance) ?? config.appearanceProfile,
    scene: String(input.scene ?? '').slice(0, MAX_SCENE_LENGTH),
    location: setting && setting.location,
    style: config.photoStyle ?? (setting && setting.style),
    negativePrompt: config.negativePrompt,
  }
  const template = config.promptTemplate ?? DEFAULT_PROMPT_TEMPLATE
  return String(template).replace(/\{(characterName|appearance|scene|location|style|negativePrompt)\}/g,
    (match, key) => values[key] == null ? '' : String(values[key]))
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, description) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ImageProviderError(`${description} timed out after ${timeoutMs}ms`, { cause: error })
    }
    throw new ImageProviderError(`${description} failed`, { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

function maxImageBytes(config) {
  const value = Number(config.maxImageMB ?? DEFAULT_MAX_IMAGE_MB)
  if (!Number.isFinite(value) || value <= 0) throw new ImageProviderError('Invalid maxImageMB configuration')
  return Math.floor(value * 1024 * 1024)
}

function timeout(config) {
  const value = Number(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  if (!Number.isFinite(value) || value <= 0) throw new ImageProviderError('Invalid timeoutMs configuration')
  return value
}

function referenceMimeType(buffer) {
  return detectImage(buffer)?.mimeType || null
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

async function loadReferences(config, maxBytes) {
  const mode = config.referenceMode ?? 'none'
  const paths = Array.isArray(config.referenceImages) ? config.referenceImages : []
  if (mode === 'none' || paths.length === 0) return
  if (mode !== 'single' && mode !== 'array') throw new ImageProviderError('Invalid referenceMode configuration')

  let root
  try {
    root = await fs.realpath(path.resolve(config.referenceRoot || process.cwd()))
  } catch (error) {
    throw new ImageProviderError('Failed to resolve reference image directory', { cause: error })
  }
  const selected = mode === 'single' ? paths.slice(0, 1) : paths
  const images = []
  let totalBytes = 0
  for (const filename of selected) {
    let data
    try {
      const candidate = path.resolve(root, filename)
      if (!inside(root, candidate)) throw new Error('outside-reference-root')
      const resolved = await fs.realpath(candidate)
      if (!inside(root, resolved)) throw new Error('reference-symlink-outside-root')
      data = await fs.readFile(resolved)
    } catch (error) {
      throw new ImageProviderError('Failed to read reference image from the allowed directory', { cause: error })
    }
    totalBytes += data.length
    if (totalBytes > maxBytes) throw new ImageProviderError('Reference images exceed image size limit')
    const mimeType = referenceMimeType(data, filename)
    if (!mimeType) throw new ImageProviderError('Reference file is not a supported image')
    images.push(`data:${mimeType};base64,${data.toString('base64')}`)
  }
  return mode === 'single' ? images[0] : images
}

function decodeBase64(value) {
  let encoded = String(value).trim()
  if (/^data:/i.test(encoded)) {
    const match = /^data:[^,]*;base64,(.*)$/is.exec(encoded)
    if (!match) throw new ImageProviderError('Image provider returned invalid base64 image data')
    encoded = match[1]
  }
  return Buffer.from(encoded.replace(/\s/g, ''), 'base64')
}

function assertSuccess(response, description) {
  if (!response || response.ok !== true || response.status < 200 || response.status >= 300) {
    const status = response && Number.isInteger(response.status) ? ` with HTTP status ${response.status}` : ''
    throw new ImageProviderError(`${description} failed${status}`)
  }
}

async function readJson(response, timeoutMs) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ImageProviderError(`Image provider response body timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  try {
    return await Promise.race([response.json(), timeout])
  } catch (error) {
    if (error instanceof ImageProviderError) throw error
    throw new ImageProviderError('Image provider returned invalid JSON', { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

async function readImageBody(response, timeoutMs, maxBytes) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new ImageProviderError(`Image response body timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  let iterator
  try {
    if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      iterator = response.body[Symbol.asyncIterator]()
      const chunks = []
      let total = 0
      while (true) {
        const step = await Promise.race([iterator.next(), timeout])
        if (step.done) break
        const chunk = Buffer.from(step.value)
        total += chunk.length
        if (total > maxBytes) {
          await iterator.return?.()
          throw new ImageProviderError('Generated image exceeds image size limit')
        }
        chunks.push(chunk)
      }
      return imageResult(Buffer.concat(chunks, total), maxBytes)
    }
    const buffer = Buffer.from(await Promise.race([response.arrayBuffer(), timeout]))
    return imageResult(buffer, maxBytes)
  } catch (error) {
    if (iterator) {
      try { await iterator.return?.() } catch {}
    }
    if (error instanceof ImageProviderError) throw error
    throw new ImageProviderError('Failed to read image download response', { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

function remoteUrl(value, description) {
  let url
  try {
    url = new URL(value)
  } catch (error) {
    throw new ImageProviderError(`${description} is invalid`, { cause: error })
  }
  const hostname = url.hostname.toLowerCase()
  let privateHost = hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.includes(':')
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    const [a, b] = hostname.split('.').map(Number)
    privateHost ||= a === 0 || a === 10 || a === 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168
      || a === 100 && b >= 64 && b <= 127
  }
  if (url.protocol !== 'https:' || url.username || url.password || privateHost) {
    throw new ImageProviderError(`${description} must be a public HTTPS URL without credentials`)
  }
  return url
}

function redirectLocation(response) {
  if (typeof response.headers?.get === 'function') return response.headers.get('location')
  return response.headers?.location
}

async function downloadImage(fetchImpl, value, timeoutMs, maxBytes) {
  let url = remoteUrl(value, 'Image URL')
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchWithTimeout(fetchImpl, url.href, { redirect: 'manual' }, timeoutMs, 'Image download')
    if (response.status >= 300 && response.status < 400) {
      if (redirects === 3) throw new ImageProviderError('Image download exceeded redirect limit')
      const location = redirectLocation(response)
      if (!location) throw new ImageProviderError('Image download redirect has no destination')
      url = remoteUrl(new URL(location, url).href, 'Image redirect URL')
      continue
    }
    assertSuccess(response, 'Image download')
    return readImageBody(response, timeoutMs, maxBytes)
  }
  throw new ImageProviderError('Image download failed')
}

exports.createImageProvider = function createImageProvider(config, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch
  return {
    async generate({ scene, purpose, story } = {}) {
      if (typeof fetchImpl !== 'function') throw new ImageProviderError('Fetch is not available')
      if (!config || typeof config.endpoint !== 'string' || !config.endpoint) {
        throw new ImageProviderError('Image provider endpoint is required')
      }
      const endpoint = remoteUrl(config.endpoint, 'Image provider endpoint')
      const maxBytes = maxImageBytes(config)
      const timeoutMs = timeout(config)
      const reference = await loadReferences(config, maxBytes)
      const body = {
        model: config.model,
        prompt: makePrompt(config, { scene, purpose, story }),
        size: config.size,
        n: 1,
        response_format: 'b64_json',
        ...(config.extraBody && typeof config.extraBody === 'object' && !Array.isArray(config.extraBody)
          ? config.extraBody : {}),
      }
      if (reference !== undefined) body.image = reference

      const response = await fetchWithTimeout(fetchImpl, endpoint.href, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${config.apiKey ?? ''}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
      }, timeoutMs, 'Image provider request')
      assertSuccess(response, 'Image provider request')

      const payload = await readJson(response, timeoutMs)
      const item = [payload && payload.data && payload.data[0], payload && payload.images && payload.images[0]]
        .find(candidate => candidate && (candidate.b64_json || candidate.url))
      if (!item) throw new ImageProviderError('Image provider returned no image')
      if (item.b64_json) return imageResult(decodeBase64(item.b64_json), maxBytes)
      return downloadImage(fetchImpl, item.url, timeoutMs, maxBytes)
    },
  }
}

exports.DEFAULT_PROMPT_TEMPLATE = DEFAULT_PROMPT_TEMPLATE
