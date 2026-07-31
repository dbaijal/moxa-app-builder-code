/*
* <license header>
*/

/**
 * Shared SendGrid email-sending helper, used across multiple event-triggered
 * actions (series-cf-trigger and others) so the SendGrid call isn't
 * duplicated per action.
 */

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

module.exports = { sendEmail }
