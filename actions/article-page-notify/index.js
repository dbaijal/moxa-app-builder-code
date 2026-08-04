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
 * "Article" detection: the page-published event payload includes the page's
 * template at data.template.id, so we scope by TEMPLATE (ARTICLE_TEMPLATE
 * input) rather than by path. This is more precise than a path prefix and
 * immune to content being reorganized under a different path - at NO extra
 * cost, since the template id is right there on the event (no AEM lookup
 * needed). The event fires for EVERY page publish across the instance, so any
 * page whose template doesn't match is skipped (200, no error).
 *
 * Confirmed event shape (captured from a real activation; `time` is top-level
 * on the CloudEvents envelope, the page data is under `data`):
 * {
 *   type: "aem.sites.page.published",
 *   time: "2026-08-03T10:14:16.052154707Z",
 *   data: {
 *     path: "/content/moxa-poc/en/articles/my-article",
 *     template: { id: "/conf/moxa-poc/settings/wcm/templates/article-sample-template" },
 *     tier: "publish",
 *     sourceUrl: "https://publish-....adobeaemcloud.com",   // NOTE: publish host, not author
 *     user: { displayName: "...", principalId: "...@adobe.com", imsUserId: "..." }
 *   }
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

// True only if this published page's template matches the configured article
// template. The template id is on the event payload at data.template.id.
// Kept trivial and pure so it's easy to unit test. Empty/undefined configured
// template -> nothing matches (safer than emailing on every page publish if
// the input is ever misconfigured).
function isArticlePage (event, articleTemplate) {
  return Boolean(articleTemplate) && event?.template?.id === articleTemplate
}

function buildEmail (event, publishedAt, authorUrl) {
  const pagePath = event.path || '(unknown path)'
  const publishedBy = event.user?.displayName || event.user?.principalId || '(unknown user)'
  publishedAt = publishedAt || '(unknown time)'

  // Full clickable author (edit) URL, e.g.
  // https://author-....adobeaemcloud.com/editor.html/content/.../my-article.html
  // The email is plain text, so mail clients auto-linkify the bare URL. Fall
  // back to the raw path if the author host isn't configured or path is unknown.
  const pageLink = (authorUrl && event.path)
    ? `${authorUrl}/editor.html${pagePath}.html`
    : pagePath

  const subject = `Article Page Published: ${pagePath}`
  const text = [
    'An article page was published in AEM Sites.',
    '',
    `Page:          ${pageLink}`,
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
    const templateId = event.template?.id

    // The page-published event fires for ANY page publish - skip anything whose
    // template isn't the article template (200, no error, so it isn't retried).
    if (!isArticlePage(event, params.ARTICLE_TEMPLATE)) {
      logger.info(`${pagePath || '(no path)'} template ${templateId} != ${params.ARTICLE_TEMPLATE} - skipping`)
      return { statusCode: 200, body: { message: 'skipped - not an article page', path: pagePath, template: templateId } }
    }

    logger.info(`Article page published: ${pagePath}`)
    const { subject, text } = buildEmail(event, params.time, params.AEM_AUTHOR_URL)

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
