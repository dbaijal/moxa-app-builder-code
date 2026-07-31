/*
* <license header>
*/

/**
 * Action: generic
 * Registered as the "Runtime action" target for the AEM Content Fragment
 * "published" event (Adobe I/O Events -> Developer Console event registration).
 *
 * On every aem.sites.contentFragment.published event, sends a notification email
 * via SendGrid to every address in NOTIFY_EMAILS below.
 *
 * Uses SendGrid (not Resend) specifically because SendGrid's single-sender
 * verification (verify ONE email address via a confirmation link) allows sending
 * to ANY recipient - including colleagues - unlike Resend's sandbox sender, which
 * only allows sending to the Resend account's own email until a full domain is
 * DNS-verified. FROM_EMAIL below MUST be the exact address verified as a
 * "Single Sender" in SendGrid (Settings > Sender Authentication).
 *
 * Confirmed real event shape (captured from a live activation log):
 * {
 *   type: "aem.sites.contentFragment.published",
 *   data: {
 *     path: "/content/dam/.../my-cf",
 *     model: { path: "/conf/.../models/article" },
 *     tier: "publish",
 *     sourceUrl: "https://publish-....adobeaemcloud.com",
 *     user: { displayName: "...", principalId: "...@adobe.com" }
 *   },
 *   time: "2026-07-22T08:47:36.249368067Z"
 * }
 */

const { Core } = require('@adobe/aio-sdk')
const { stringParameters } = require('../utils')

// ---------------------------------------------------------------------------
// EMAIL CONTENT - edit this section to change what gets sent, no logic changes needed
// ---------------------------------------------------------------------------
const NOTIFY_EMAILS = [
  'dbaijal@adobe.com',
  // add colleagues here, e.g. 'colleague@adobe.com',
]
const FROM_EMAIL = 'dbaijal@adobe.com' // must match your verified Single Sender in SendGrid
const FROM_NAME = 'AEM CF Notifications'

function buildEmail (event, publishedAt) {
  const cfPath = event.path || '(unknown path)'
  const publishedBy = event.user?.displayName || event.user?.principalId || '(unknown user)'
  publishedAt = publishedAt || '(unknown time)'

  const subject = `Content Fragment Published: ${cfPath}`
  const text = [
    'A Content Fragment was published in AEM.',
    '',
    `Path:          ${cfPath}`,
    `Published by:  ${publishedBy}`,
    `Published at:  ${publishedAt}`,
  ].join('\n')

  return { subject, text }
}
// ---------------------------------------------------------------------------

async function sendEmail ({ apiKey, to, from, fromName, subject, text }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: to.map((email) => ({ email })) }],
      from: { email: from, name: fromName },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
  })
  // SendGrid returns 202 with an empty body on success; only try to parse JSON on error
  const body = res.ok ? null : await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, body }
}

async function main (params) {
  const logger = Core.Logger('main', { level: params.LOG_LEVEL || 'info' })

  try {
    logger.info('Calling the main action')
    logger.debug(stringParameters(params))

    // params.data is the actual AEM event payload; params.time is top-level (see confirmed shape above)
    const event = params.data || {}
    const { subject, text } = buildEmail(event, params.time)

    // Email sending temporarily disabled to verify event invocation without sending mail each test.
    let emailResult = { skipped: true }
    // if (params.SENDGRID_API_KEY) {
    //   emailResult = await sendEmail({
    //     apiKey: params.SENDGRID_API_KEY,
    //     to: NOTIFY_EMAILS,
    //     from: FROM_EMAIL,
    //     fromName: FROM_NAME,
    //     subject,
    //     text,
    //   })
    //   logger.info(`Email send result: ${JSON.stringify(emailResult)}`)
    // } else {
    //   logger.warn('SENDGRID_API_KEY not configured - skipping email send')
    // }

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
