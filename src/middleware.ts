import { defineMiddleware } from 'astro/middleware'
import { cacheHtml, HTML_CACHE_CONTROL } from './lib/html-cache'

function getEncodedTagSearchQuery(pathname: string): string {
  if (!pathname.startsWith('/search/%23')) {
    return ''
  }

  try {
    return decodeURIComponent(pathname.slice('/search/'.length))
  }
  catch {
    return ''
  }
}

export function isHtmlResponse(response: Response): boolean {
  return response.headers.get('content-type')?.includes('text/html') ?? false
}

export function shouldApplyDefaultCache(response: Response): boolean {
  return response.status >= 200 && response.status < 400 && !response.headers.has('Cache-Control')
}

export const onRequest = defineMiddleware(async (context, next) => {
  const isDataPath = /\.(?:json|xml)$/.test(context.url.pathname)

  if (isDataPath && context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
    })
  }

  context.locals.SITE_URL = `${import.meta.env.SITE ?? ''}${import.meta.env.BASE_URL}`
  context.locals.RSS_URL = `${context.locals.SITE_URL}rss.xml`
  context.locals.RSS_PREFIX = ''

  const querySearch = context.url.searchParams.get('q') || ''
  const legacyTagSearch = getEncodedTagSearchQuery(context.url.pathname)
  const pathSearch = context.params.q || ''
  const searchQuery = querySearch || legacyTagSearch || pathSearch

  if (context.url.pathname.startsWith('/search') && searchQuery.startsWith('#')) {
    const tag = searchQuery.replace('#', '')
    context.locals.RSS_URL = `${context.locals.SITE_URL}rss.xml?tag=${encodeURIComponent(tag)}`
    context.locals.RSS_PREFIX = `${tag} | `
  }

  const render = async () => {
    const response = legacyTagSearch
      ? await context.rewrite(`/search/result?q=${encodeURIComponent(legacyTagSearch)}`)
      : await next()

    if (response.bodyUsed) {
      return response
    }

    if (isDataPath) {
      response.headers.set('Access-Control-Allow-Origin', '*')
    }

    if (isHtmlResponse(response)) {
      response.headers.set('Speculation-Rules', '"/rules/prefetch.json"')
    }

    if (shouldApplyDefaultCache(response)) {
      response.headers.set('Cache-Control', isHtmlResponse(response) ? HTML_CACHE_CONTROL : 'public, max-age=300, s-maxage=300')
    }
    return response
  }

  const locals = context.locals as App.Locals & { cfContext?: { waitUntil: (task: Promise<unknown>) => void } }
  const base = import.meta.env.BASE_URL ?? '/'
  const pathname = `/${context.url.pathname.slice(base.length)}`
  const isPage = /^\/(?:$|(?:before|after|posts)\/[^/]+\/?$|(?:tags|links|search\/result)\/?$)/.test(pathname)
  return cacheHtml(context.request, render, {
    enabled: isPage && !legacyTagSearch,
    ctx: locals.cfContext,
    hasCookies: () => !context.cookies.headers().next().done,
  })
})
