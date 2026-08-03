/*
* <license header>
*/

/**
 * Action: article-page-notify
 * Registered as the "Runtime action" target for the AEM Sites page
 * "published" event (Adobe I/O Events -> Developer Console event registration).
 * NOTE: this is a DIFFERENT event type from the Content Fragment work in
 * generic/series-cf-trigger - a Sites *page* being replicated (published) is
 * aem.sites.page.published, not aem.sites.contentFragment.published. This
 * action is fully additive and shares no logic with the CF actions (only the
 * shared lib/email.js sender).
 *
 * On every page-published event, IF the page is an "article" page, sends a
 * notification email via SendGrid to every address in NOTIFY_EMAILS below.
 *
 * "Article" detection: a page carries no CF-style "model" field, so there is
 * nothing on the event payload that says "this is an article". We scope by
 * PATH PREFIX instead (ARTICLE_PATH_PREFIX input) - the same approach
 * series-cf-trigger uses to scope the shared CF event to Moxa series CFs. The
 * page-published event fires for EVERY page publish across the instance, so
 * anything outside that prefix is skipped (200, no error). To scope by
 * template instead, you'd need an extra fetch to the publish tier to read the
 * page's cq:template - deliberately not done here to keep the POC simple.
 *
 * Expected event shape (mirrors the confirmed CF payload; `time` is top-level,
 * the page data is under `data`):
 * {
 *   type: "aem.sites.page.published",
 *   data: {
 *     path: "/content/<site>/<lang>/articles/my-article",
 *     tier: "publish",
 *     sourceUrl: "https://author-....adobeaemcloud.com",
 *     user: { displayName: "...", principalId: "...@adobe.com" }
 *   },
 *   time: "2026-08-03T08:47:36.249368067Z"
 * }
 *
 * Uses the shared SendGrid sender (lib/email.js) with a Gmail FROM_EMAIL, NOT
 * an @adobe.com address - Adobe's domain has a strict DMARC policy that blocks
 * mail sent via an unauthorized third party (SendGrid), even with Single
 * Sender Verification (see the same note in series-cf-trigger). FROM_EMAIL
 * below MUST be verified as a "Single Sender" in SendGrid.
 */

const { Core } = require('@adobe/aio-sdk')
const { stringParameters } = require('../utils')
const { sendEmail } = require('../lib/email')

// ---------------------------------------------------------------------------
// EMAIL CONTENT - edit this section to change what gets sent, no logic changes needed
// ---------------------------------------------------------------------------
const NOTIFY_EMAILS = [
  //'dbaijal@adobe.com',
  'sadduri@adobe.com','gauravraheja@adobe.com','dbaijal@adobe.com','ghu@adobe.com',
  // add colleagues here, e.g. 'colleague@adobe.com',
]
const FROM_EMAIL = 'baijal.deepti20@gmail.com' // must match your verified Single Sender in SendGrid
const FROM_NAME = 'AEM Page Notifications'

// True only if this published page is an article page. Kept trivial and pure
// so it's easy to unit test. Empty/undefined prefix -> nothing matches (safer
// than emailing on every page publish if the input is ever misconfigured).
function isArticlePage (path, prefix) {
  return Boolean(path) && Boolean(prefix) && path.startsWith(prefix)
}

function buildEmail (event, publishedAt) {
  const pagePath = event.path || '(unknown path)'
  const publishedBy = event.user?.displayName || event.user?.principalId || '(unknown user)'
  publishedAt = publishedAt || '(unknown time)'

  const subject = `Article Page Published: ${pagePath}`
  const text = [
    'An article page was published in AEM Sites.',
    '',
    `Path:          ${pagePath}`,
    `Published by:  ${publishedBy}`,
    `Published at:  ${publishedAt}`,
  ].join('\n')

  return { subject, text }
}
// ---------------------------------------------------------------------------

async function main (params) {
  const logger = Core.Logger('article-page-notify', { level: params.LOG_LEVEL || 'info' })

  try {
    logger.info('Calling the article-page-notify action')
    logger.debug(stringParameters(params))

    // params.data is the actual AEM page event payload; params.time is top-level.
    const event = params.data || {}
    const pagePath = event.path || ''

    // The page-published event fires for ANY page publish - skip anything that
    // isn't an article page (200, no error, so it isn't retried/flagged).
    if (!isArticlePage(pagePath, params.ARTICLE_PATH_PREFIX)) {
      logger.info(`${pagePath || '(no path)'} is not an article page (prefix ${params.ARTICLE_PATH_PREFIX}) - skipping`)
      return { statusCode: 200, body: { message: 'skipped - not an article page', path: pagePath } }
    }

    logger.info(`Article page published: ${pagePath}`)
    const { subject, text } = buildEmail(event, params.time)

    let emailResult = { skipped: true }
    if (params.SENDGRID_API_KEY) {
      emailResult = await sendEmail({
        apiKey: params.SENDGRID_API_KEY,
        to: NOTIFY_EMAILS,
        from: FROM_EMAIL,
        fromName: FROM_NAME,
        subject,
        text,
      })
      logger.info(`Email send result: ${JSON.stringify(emailResult)}`)
    } else {
      logger.warn('SENDGRID_API_KEY not configured - skipping email send')
    }

    const response = {
      statusCode: 200,
      body: { message: 'processed', subject, text, emailResult }
    }
    logger.info(`${response.statusCode}: successful request`)
    return response
  } catch (error) {
    logger.error(error)
    return {
      statusCode: 500,
      body: { error: error.message || 'server error' }
    }
  }
}

exports.main = main
