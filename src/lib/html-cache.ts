export const HTML_CACHE_CONTROL = 'public, max-age=60, s-maxage=900, stale-while-revalidate=86400'

const FRESH_SECONDS = 900
const STALE_SECONDS = 86400
const STORED_AT = 'X-BroadcastChannel-Cached-At'
// Only URL markers are shared, never request objects or cross-request I/O promises.
// This coalesces stale refreshes within an isolate, not across data centers.
const refreshing = new Set<string>()

interface CacheOptions {
  enabled: boolean
  ctx?: { waitUntil: (task: Promise<unknown>) => void }
  hasCookies: () => boolean
}

export function isShareableHtml(response: Response): boolean {
  const cacheControl = response.headers.get('Cache-Control') ?? ''
  return response.ok && response.status !== 206 && !response.bodyUsed
    && (response.headers.get('Content-Type')?.includes('text/html') ?? false)
    && !response.headers.has('Set-Cookie')
    && !response.headers.has('Vary')
    && !/\b(?:private|no-store|no-cache)\b/i.test(cacheControl)
    && /\bpublic\b/i.test(cacheControl)
}

export async function cacheHtml(request: Request, render: () => Promise<Response>, options: CacheOptions): Promise<Response> {
  const cache = (globalThis.caches as (CacheStorage & { default?: Cache }) | undefined)?.default
  if (!options.enabled || !cache || request.method !== 'GET'
    || request.headers.has('Authorization') || request.headers.has('Cookie')
    || request.headers.has('Range')) {
    return render()
  }

  // A header-free GET key preserves the full URL, including query parameters.
  const key = new Request(request.url)
  let cached: Response | undefined
  try {
    cached = await cache.match(key)
  }
  catch (error) {
    console.warn('HTML cache lookup failed', error)
  }

  const renderAndStore = async (background = false) => {
    const response = await render()
    if (isShareableHtml(response) && !options.hasCookies()
      && response.headers.get('Cache-Control') === HTML_CACHE_CONTROL) {
      const stored = new Response(response.clone().body, response)
      // Cache API does not implement SWR: retain stale HTML and track freshness ourselves.
      stored.headers.set('Cache-Control', `public, max-age=${FRESH_SECONDS + STALE_SECONDS}`)
      stored.headers.set(STORED_AT, String(Date.now()))
      const write = cache.put(key, stored).catch((error) => {
        console.warn('HTML cache write failed', error)
      })
      if (options.ctx && !background) {
        options.ctx.waitUntil(write)
      }
      else {
        await write
      }
    }
    return response
  }

  const storedAt = Number(cached?.headers.get(STORED_AT) ?? Number.NaN)
  const age = Math.max(0, Math.floor((Date.now() - storedAt) / 1000))
  if (cached && Number.isFinite(age) && age < FRESH_SECONDS + STALE_SECONDS
    && (age < FRESH_SECONDS || options.ctx)) {
    if (age >= FRESH_SECONDS && options.ctx && !refreshing.has(key.url)) {
      refreshing.add(key.url)
      options.ctx.waitUntil((async () => {
        try {
          const response = await renderAndStore(true)
          // Consume the unused branch so a streamed render can finish in the background.
          await response.body?.cancel()
        }
        catch (error) {
          console.warn('HTML cache refresh failed', error)
        }
        finally {
          refreshing.delete(key.url)
        }
      })())
    }
    const response = new Response(cached.body, cached)
    response.headers.delete(STORED_AT)
    response.headers.set('Cache-Control', HTML_CACHE_CONTROL)
    response.headers.set('Age', String(age))
    return response
  }

  return renderAndStore()
}
