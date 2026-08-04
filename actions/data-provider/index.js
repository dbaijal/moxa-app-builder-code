/*
* <license header>
*/

/**
 * Action: data-provider
 * Purpose: BYOM (Bring Your Own Markup) content source for paths under /products/*.
 * Invoked by the Helix Admin API when resolving preview/live content for a path
 * configured as this site's content.overlay.url (see https://www.aem.live/developer/byom).
 *
 * Routing rules:
 * - Path not matching PRODUCTS_PATH_RE at all           -> 404 (falls back to primary source)
 * - /{locale}/products/{x}                              -> SERIES page (series.html), seriesId = x
 * - /{locale}/products/{x}/{y}                          -> MODEL page  (model.html),  seriesId = x, modelId = y
 * - /{locale}/products/{x}/{y}/{z...} or no id at all    -> 404 (not a valid series/model depth)
 *
 * Dynamic content: for both page types, content now comes from the real Moxa
 * PDIM product API (see lib/pdim.js) - GraphQL/CF-based lookup (fetchCfData/
 * buildCfPath below) is kept in place, unused, in case it's needed again later.
 * URL segments are human-readable slugs but the API's seriesId/modelId are
 * opaque codes, so fetchPdimData() matches by slugifying seriesName/modelName
 * and comparing against the segment. lib/pdim.js also normalizes the raw API
 * response (DITA-XML overview topics, JSON-stringified spec items, a malformed
 * "feature" field, cvisible-flagged duplicate specs) into clean JSON.
 *
 * Real HTML/section mapping isn't ready yet, so for now both templates dump
 * the normalized JSON in a <pre> block below the hero text, purely to verify
 * the data end-to-end through the real preview flow.
 *
 * Error handling (deliberate distinction):
 * - PDIM API call itself fails (network error, non-200) -> 500. Treated as transient,
 *   not "page doesn't exist" - this matters because Lars's webhook action retries
 *   preview up to 3 times specifically when the response isn't a clean 200, so a
 *   transient failure gets a chance to self-heal on retry.
 * - PDIM API call succeeds but no series/model slug matches -> 404. Genuinely
 *   "not found" (bad slug, typo'd URL, disabled item) - correctly NOT retried.
 *
 * `templates/product.html` is the original sample template from the first pass of
 * this POC - left untouched on disk for reference, no longer wired into main().
 *
 * Note on web:'raw' (see app.config.yaml): this action is invoked by the Helix
 * Admin API via a real HTTP GET (an external system fetching a URL) - unlike an
 * Adobe I/O Events-triggered action (which should be a non-web action), this one
 * genuinely needs to be a web action so it has a real, fetchable URL.
 *
 * Structure mirrors Lars's data-provider (byom-demo) and the aem-commerce-prerender
 * pdp-renderer: markup lives in its own template file, rendered via Handlebars,
 * kept separate from the path-parsing/routing logic in this file.
 */

const { Core } = require('@adobe/aio-sdk')
const Handlebars = require('handlebars')
const fs = require('fs')
const pdim = require('../lib/pdim')

const PRODUCTS_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\/(.*)$/i

// TEMPORARY - template testing scenario, remove once no longer needed.
// Serves templates/test.html as static markup for /en/test (or /{locale}/test),
// bypassing all product/CF logic below. Edit test.html directly to try out markup.
const TEST_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?test$/i

function notOurPath (path) {
  return {
    statusCode: 404,
    body: `${path} is not handled by this content source`,
    headers: { 'Content-Type': 'text/plain' },
  }
}

// Extracts the segments AFTER the (optional locale +) "products" prefix.
// e.g. "/en/products/x/y" -> ["x", "y"]; "/products/x" -> ["x"]; "/en/products/" -> []
function getProductSegments (path) {
  const match = path.match(PRODUCTS_PATH_RE)
  if (!match) return null
  return match[1].split('/').filter(Boolean)
}

function renderTemplate (templateName, data) {
  const templateContent = fs.readFileSync(`${__dirname}/templates/${templateName}`, 'utf-8')
  const template = Handlebars.compile(templateContent)
  return template(data)
}

function buildCfPath (cfBasePath, cfId) {
  return `${cfBasePath}${cfId}`
}

// Returns { item: {seriesName, seriesDesc} } on success,
// { notFound: true } if the query succeeded but no CF matched,
// { fetchFailed: true } if the call itself errored (network/non-200).
async function fetchCfData (cfId, { CF_BASE_PATH, AEM_PUBLISH_URL }, logger) {
  const cfPath = buildCfPath(CF_BASE_PATH, cfId)
  // Persisted GraphQL queries get cached at the dispatcher/CDN layer, so an edited
  // CF can keep returning stale data for the same URL. Appending a cache-busting
  // timestamp makes each request's URL unique, forcing a fresh fetch every time.
  // Confirmed via direct curl that AEM ignores this extra param (not one of the
  // query's variables) rather than erroring on it.
  const url = `${AEM_PUBLISH_URL}/graphql/execute.json/moxa-poc/getSeriesModelDesc;path=${cfPath}?ts=${Date.now()}`

  try {
    const res = await fetch(url)
    if (!res.ok) {
      logger.error(`GraphQL call failed for ${cfPath}: HTTP ${res.status}`)
      return { fetchFailed: true }
    }

    const json = await res.json()
    const item = json?.data?.moxaSeriesModelCfByPath?.item
    if (!item) {
      logger.info(`No CF found at ${cfPath}`)
      return { notFound: true }
    }

    return { item }
  } catch (error) {
    logger.error(`GraphQL call threw for ${cfPath}`, error)
    return { fetchFailed: true }
  }
}

// Supplementary CF-authored content (download link/text, model-page header
// text/desc) for series and model pages. One CF per series now serves BOTH
// the series page and every model page under it - so this is always queried
// by series slug only, never a per-model CF path. Kept separate from
// fetchCfData/buildCfPath above (untouched, per earlier note) since this is a
// new query against the updated CF schema, not a change to the old one.
//
// Returns { item: {...} } on success, { notFound: true } if the CF query
// succeeded but returned nothing, { fetchFailed: true } if the call errored.
async function fetchSeriesCfData (seriesSlug, { CF_BASE_PATH, AEM_PUBLISH_URL }, logger) {
  const cfPath = `${CF_BASE_PATH}${seriesSlug}`
  // Same cache-busting rationale as fetchCfData above - persisted GraphQL
  // queries get cached at the dispatcher/CDN layer.
  const url = `${AEM_PUBLISH_URL}/graphql/execute.json/moxa-poc/getSeriesModelDesc;path=${cfPath}?ts=${Date.now()}`

  try {
    const res = await fetch(url)
    if (!res.ok) {
      logger.error(`Series CF GraphQL call failed for ${cfPath}: HTTP ${res.status}`)
      return { fetchFailed: true }
    }

    const json = await res.json()
    const item = json?.data?.moxaSeriesModelCfByPath?.item
    if (!item) {
      logger.info(`No series CF found at ${cfPath}`)
      return { notFound: true }
    }

    return { item }
  } catch (error) {
    logger.error(`Series CF GraphQL call threw for ${cfPath}`, error)
    return { fetchFailed: true }
  }
}

// Real PDIM API lookup for series/model pages (replaces the GraphQL/CF lookup
// above for these two page types - fetchCfData is kept as-is, unused, in case
// it's needed again later). URL segments are human-readable slugs but the
// API's seriesId/modelId are opaque codes, so matching is done by slugifying
// seriesName/modelName and comparing against the URL segment.
//
// Returns { series: {...} } or { model: {...} } (see lib/pdim.js for shape),
// { notFound: true } if nothing matched the slug(s), or { fetchFailed: true }
// if the API call itself errored.
async function fetchPdimData (segments, params, logger) {
  let list
  try {
    list = await pdim.fetchProductList(params)
  } catch (error) {
    logger.error('PDIM API call threw', error)
    return { fetchFailed: true }
  }

  const [seriesSegment, modelSegment] = segments
  const rawSeries = list.find((s) => pdim.slugify(s.seriesName) === seriesSegment && s.disabled !== 'Y')
  if (!rawSeries) {
    logger.info(`No series matched slug ${seriesSegment}`)
    return { notFound: true }
  }

  if (!modelSegment) {
    return { series: pdim.normalizeSeries(rawSeries) }
  }

  const rawModel = (rawSeries.models || []).find((m) => pdim.slugify(m.modelName) === modelSegment && m.disabled !== 'Y')
  if (!rawModel) {
    logger.info(`No model matched slug ${modelSegment} under series ${seriesSegment}`)
    return { notFound: true }
  }

  return { model: pdim.normalizeModel(rawModel, rawSeries) }
}

async function main (params) {
  const logger = Core.Logger('data-provider', { level: params.LOG_LEVEL || 'info' })

  try {
    let path = params.__ow_path || ''
    if (!path.startsWith('/')) path = '/' + path

    logger.info(`Invoked data-provider for path: ${path}`)

    // TEMPORARY - template testing scenario, remove once no longer needed.
    if (TEST_PATH_RE.test(path)) {
      logger.info(`Test path ${path} - serving test.html`)
      return {
        statusCode: 200,
        body: renderTemplate('test.html', {}),
        headers: { 'Content-Type': 'text/html' },
      }
    }

    const segments = getProductSegments(path)

    if (segments === null) {
      logger.info(`${path} not handled here, returning 404 (fall back to primary source)`)
      return notOurPath(path)
    }

    let templateName
    if (segments.length === 1) {
      logger.info(`Series page for slug=${segments[0]}`)
      templateName = 'series.html'
    } else if (segments.length === 2) {
      logger.info(`Model page for series slug=${segments[0]}, model slug=${segments[1]}`)
      templateName = 'model.html'
    } else {
      // 0 segments (bare /products) or 3+ segments (too deep) - not a valid page
      logger.info(`${path} has ${segments.length} segment(s) after /products, not a valid series/model depth - 404`)
      return notOurPath(path)
    }

    const result = await fetchPdimData(segments, params, logger)

    if (result.fetchFailed) {
      return {
        statusCode: 500,
        body: `Failed to fetch content for ${segments.join('/')}`,
        headers: { 'Content-Type': 'text/plain' },
      }
    }
    if (result.notFound) {
      return {
        statusCode: 404,
        body: `No content found for ${segments.join('/')}`,
        headers: { 'Content-Type': 'text/plain' },
      }
    }

    // Series slug is always segments[0], whether this is a series or model
    // page - same CF serves both.
    const cfResult = await fetchSeriesCfData(segments[0], params, logger)

    if (cfResult.fetchFailed) {
      return {
        statusCode: 500,
        body: `Failed to fetch supplementary content for ${segments[0]}`,
        headers: { 'Content-Type': 'text/plain' },
      }
    }
    if (cfResult.notFound) {
      return {
        statusCode: 404,
        body: `No supplementary content found for ${segments[0]}`,
        headers: { 'Content-Type': 'text/plain' },
      }
    }

    const cfItem = cfResult.item
    const downloadLink = {
      text: cfItem.labelDownloadProductInfo,
      url: cfItem.productInfoLink?._path ? `${params.AEM_PUBLISH_URL}${cfItem.productInfoLink._path}` : null,
    }

    const content = result.series || result.model
    content.downloadLink = downloadLink
    if (result.model) {
      content.modelPageHeader = {
        heading: cfItem.modelPageHeaderText,
        description: cfItem.modelPageHeaderDesc?.plaintext || null,
        image: cfItem.modelPageHeaderImage?._path ? `${params.AEM_PUBLISH_URL}${cfItem.modelPageHeaderImage._path}` : null,
      }
    }

    const html = renderTemplate(templateName, {
      ...content,
      json: JSON.stringify(content, null, 2),
    })

    logger.info(`Returning HTML for ${path}`)
    return {
      statusCode: 200,
      body: html,
      headers: { 'Content-Type': 'text/html' },
    }
  } catch (error) {
    logger.error(error)
    return {
      statusCode: 500,
      body: 'server error',
      headers: { 'Content-Type': 'text/plain' },
    }
  }
}

exports.main = main
