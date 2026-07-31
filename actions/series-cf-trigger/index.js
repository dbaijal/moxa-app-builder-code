/*
* <license header>
*/

/**
 * Action: series-cf-trigger
 * Registered as the "Runtime action" target for the AEM Content Fragment
 * "published" event (Adobe I/O Events -> Developer Console event registration),
 * same event type as the "generic" action - but scoped specifically to the
 * series CF publish -> email-notification workflow, kept separate from
 * "generic" (which remains the original standalone CF-publish email demo,
 * untouched).
 *
 * Path scoping: this event type fires for ANY content fragment publish across
 * the AEM instance, not just Moxa series CFs - so the first thing main() does
 * is check the published CF's path is under CF_BASE_PATH, skipping (200, no
 * error) otherwise.
 *
 * Email: recipients come from the CF's own "emailAddress" field (queried via
 * the same persisted GraphQL query data-provider uses), not a hardcoded list -
 * that's the field authors configure per series CF for this exact purpose.
 * The actual SendGrid call lives in lib/email.js (shared), since a second
 * event-triggered action will also need to send email.
 *
 * Determining WHICH pages to preview/publish: model pages under a series
 * aren't derivable from the CF at all - that only exists in the PDIM API's
 * "models" array (same one data-provider queries to render pages). So
 * determineTargetPages() calls the PDIM API fresh every time this fires (no
 * hardcoded series->model mapping), finds the series by slug, and builds one
 * page path for the series itself plus one per model in its models array.
 * This stays correct automatically if PDIM's model list changes later - same
 * "no hardcoded product list" principle used everywhere else in this project.
 *
 * Preview/publish: for each target page, POST to admin.hlx.page's /preview
 * then /live endpoints (in that order - /live publishes whatever is
 * currently in preview, so publishing without previewing first would push a
 * stale version). Not aem.page/aem.live - those are just where the result
 * can be viewed afterward, not an API to trigger generation.
 */

const { Core } = require('@adobe/aio-sdk')
const { stringParameters } = require('../utils')
const { sendEmail } = require('../lib/email')
const pdim = require('../lib/pdim')

// Locale hardcoded to "en" - matches every real page path tested so far
// (data-provider's PRODUCTS_PATH_RE also supports other 2-letter locales,
// but nothing in the PDIM/CF data tells us which locales exist per series).
const LOCALE = 'en'

// Returns an array of page paths (series + all its model pages), or an empty
// array if the series isn't found in the PDIM API (e.g. CF published for a
// series PDIM doesn't have data for yet - logged as a warning, not an error).
async function determineTargetPages (seriesSlug, params, logger) {
  let list
  try {
    list = await pdim.fetchProductList(params)
  } catch (error) {
    logger.error('PDIM API call threw while determining target pages', error)
    return []
  }

  const rawSeries = list.find((s) => pdim.slugify(s.seriesName) === seriesSlug)
  if (!rawSeries) {
    logger.warn(`No PDIM series matched slug ${seriesSlug} - can't determine target pages`)
    return []
  }

  const seriesPagePath = `/${LOCALE}/products/${seriesSlug}`
  const modelPagePaths = (rawSeries.models || [])
    .filter((m) => m.disabled !== 'Y')
    .map((m) => `/${LOCALE}/products/${seriesSlug}/${pdim.slugify(m.modelName)}`)

  // PDIM's models array can contain duplicate entries (known data quality
  // issue, e.g. EDS-4008-LV-T listed twice) - de-dupe so we don't call
  // preview/publish twice for the same page.
  return [...new Set([seriesPagePath, ...modelPagePaths])]
}

async function triggerHelixRequest (route, pagePath, { HELIX_ORG, HELIX_SITE, HELIX_REF, HELIX_ADMIN_TOKEN }, logger) {
  const url = `https://admin.hlx.page/${route}/${HELIX_ORG}/${HELIX_SITE}/${HELIX_REF}${pagePath}`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `token ${HELIX_ADMIN_TOKEN}` },
    })
    const body = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, body }
  } catch (error) {
    logger.error(`Helix ${route} call threw for ${pagePath}`, error)
    return { ok: false, error: error.message }
  }
}

// Preview must succeed before publish - /live publishes whatever is
// currently in preview, so skip publish entirely if preview failed (would
// otherwise publish stale content, not this page's just-updated data).
async function previewAndPublishPage (pagePath, params, logger) {
  const preview = await triggerHelixRequest('preview', pagePath, params, logger)
  logger.info(`Preview ${pagePath}: ${JSON.stringify(preview)}`)

  if (!preview.ok) {
    return { pagePath, preview, publish: { skipped: true } }
  }

  const publish = await triggerHelixRequest('live', pagePath, params, logger)
  logger.info(`Publish ${pagePath}: ${JSON.stringify(publish)}`)

  return { pagePath, preview, publish }
}

// Using a Gmail sender (not dbaijal@adobe.com) - Adobe's domain has a strict
// DMARC policy that blocks mail sent via an unauthorized third party (SendGrid),
// even with Single Sender Verification (which only proves inbox ownership, not
// domain authorization). No such domain-impersonation conflict with Gmail.
const FROM_EMAIL = 'baijal.deepti20@gmail.com' // must match your verified Single Sender in SendGrid
const FROM_NAME = 'AEM CF Notifications'

// Returns { item: {...} } on success, { notFound: true } if the CF query
// succeeded but returned nothing, { fetchFailed: true } if the call errored.
async function fetchSeriesCfData (seriesSlug, { CF_BASE_PATH, AEM_PUBLISH_URL }, logger) {
  const cfPath = `${CF_BASE_PATH}${seriesSlug}`
  // Cache-busting timestamp - same rationale as data-provider's GraphQL calls.
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

// Series page only - no mention of model pages, even though they were also
// previewed/published above.
function buildEmail (seriesSlug, item, liveUrl) {
  const seriesName = item.seriesName || seriesSlug

  const subject = `Series page published: ${seriesName}`
  const text = [
    `The "${seriesName}" series page has been published.`,
    '',
    `Page: ${liveUrl}`,
  ].join('\n')

  return { subject, text }
}

async function main (params) {
  const logger = Core.Logger('series-cf-trigger', { level: params.LOG_LEVEL || 'info' })

  try {
    logger.info('Calling series-cf-trigger action')
    logger.debug(stringParameters(params))

    const event = params.data || {}
    const cfPath = event.path || ''

    if (!cfPath.startsWith(params.CF_BASE_PATH)) {
      logger.info(`${cfPath} is not under ${params.CF_BASE_PATH} - skipping (not a Moxa series CF)`)
      return { statusCode: 200, body: { message: 'skipped - not a Moxa series CF' } }
    }

    const seriesSlug = cfPath.slice(params.CF_BASE_PATH.length)
    logger.info(`Moxa series CF published: ${seriesSlug}`)

    const targetPages = await determineTargetPages(seriesSlug, params, logger)
    logger.info(`Target pages to preview/publish: ${JSON.stringify(targetPages)}`)

    // Sequential, not parallel - keeps logging per-page and avoids
    // hammering the admin API concurrently (only a handful of pages here).
    const pageResults = []
    for (const pagePath of targetPages) {
      pageResults.push(await previewAndPublishPage(pagePath, params, logger))
    }

    // Email is gated on the SERIES page specifically publishing successfully
    // (not the model pages) - and is only ever sent from this one call site,
    // so it's inherently triggered at most once per invocation regardless of
    // how many pages were processed above.
    const seriesPagePath = `/${LOCALE}/products/${seriesSlug}`
    const seriesPageResult = pageResults.find((r) => r.pagePath === seriesPagePath)
    const seriesPublishSucceeded = Boolean(seriesPageResult?.publish?.ok)

    const result = await fetchSeriesCfData(seriesSlug, params, logger)

    if (result.fetchFailed) {
      return { statusCode: 500, body: { error: `Failed to fetch CF data for ${seriesSlug}` } }
    }
    if (result.notFound) {
      return { statusCode: 404, body: { error: `No CF data found for ${seriesSlug}` } }
    }

    const recipients = result.item.emailAddress || []
    let subject
    let emailResult = { skipped: true }

    if (!seriesPublishSucceeded) {
      logger.warn(`Series page publish did not succeed for ${seriesSlug} - skipping email`)
    } else if (recipients.length === 0) {
      logger.warn(`No emailAddress configured on CF for ${seriesSlug} - skipping email send`)
    } else if (!params.SENDGRID_API_KEY) {
      logger.warn('SENDGRID_API_KEY not configured - skipping email send')
    } else {
      // Helix's own response already includes the live URL - fall back to
      // constructing it only if that field is ever missing.
      const liveUrl = seriesPageResult.publish.body?.live?.url
        || `https://${params.HELIX_REF}--${params.HELIX_SITE}--${params.HELIX_ORG}.aem.live${seriesPagePath}`

      const built = buildEmail(seriesSlug, result.item, liveUrl)
      subject = built.subject

      emailResult = await sendEmail({
        apiKey: params.SENDGRID_API_KEY,
        to: recipients,
        from: FROM_EMAIL,
        fromName: FROM_NAME,
        subject: built.subject,
        text: built.text,
      })
      logger.info(`Email send result: ${JSON.stringify(emailResult)}`)
    }

    const response = {
      statusCode: 200,
      body: { message: 'processed', seriesSlug, targetPages, pageResults, seriesPublishSucceeded, recipients, subject, emailResult },
    }
    logger.info(`${response.statusCode}: successful request`)
    return response
  } catch (error) {
    logger.error(error)
    return {
      statusCode: 500,
      body: { error: error.message || 'server error' },
    }
  }
}

exports.main = main
