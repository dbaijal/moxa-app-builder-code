/*
* <license header>
*/

jest.mock('@adobe/aio-sdk', () => ({
  Core: {
    Logger: jest.fn()
  }
}))

const { Core } = require('@adobe/aio-sdk')
const mockLoggerInstance = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() }
Core.Logger.mockReturnValue(mockLoggerInstance)

// Mock the shared SendGrid sender so no real HTTP call / email happens.
jest.mock('../actions/lib/email')
const { sendEmail } = require('../actions/lib/email')

const action = require('../actions/article-page-notify/index.js')

beforeEach(() => {
  Core.Logger.mockClear()
  mockLoggerInstance.info.mockReset()
  mockLoggerInstance.debug.mockReset()
  mockLoggerInstance.warn.mockReset()
  mockLoggerInstance.error.mockReset()
  sendEmail.mockReset()
})

// A realistic page-published event payload for an article page.
const articleEvent = {
  ARTICLE_PATH_PREFIX: '/content/moxa-poc/en/articles/',
  SENDGRID_API_KEY: 'fake-key',
  time: '2026-08-03T08:47:36.249368067Z',
  data: {
    path: '/content/moxa-poc/en/articles/my-article',
    tier: 'publish',
    user: { displayName: 'Deepti Baijal', principalId: 'dbaijal@adobe.com' }
  }
}

describe('article-page-notify', () => {
  test('main should be defined', () => {
    expect(action.main).toBeInstanceOf(Function)
  })

  test('should set logger to use LOG_LEVEL param', async () => {
    await action.main({ ...articleEvent, LOG_LEVEL: 'fakeLevel' })
    expect(Core.Logger).toHaveBeenCalledWith(expect.any(String), { level: 'fakeLevel' })
  })

  test('sends an email for an article page publish', async () => {
    sendEmail.mockResolvedValue({ ok: true, status: 202, body: null })

    const response = await action.main(articleEvent)

    expect(sendEmail).toHaveBeenCalledTimes(1)
    const arg = sendEmail.mock.calls[0][0]
    expect(arg.to).toContain('dbaijal@adobe.com')
    expect(arg.subject).toContain('/content/moxa-poc/en/articles/my-article')
    expect(response.statusCode).toBe(200)
    expect(response.body.message).toBe('processed')
    expect(response.body.emailResult).toEqual({ ok: true, status: 202, body: null })
  })

  test('skips (no email) when the published page is NOT under the article prefix', async () => {
    const response = await action.main({
      ...articleEvent,
      data: { ...articleEvent.data, path: '/content/moxa-poc/en/products/eds-4008-series' }
    })

    expect(sendEmail).not.toHaveBeenCalled()
    expect(response.statusCode).toBe(200)
    expect(response.body.message).toBe('skipped - not an article page')
  })

  test('skips when ARTICLE_PATH_PREFIX is not configured', async () => {
    const response = await action.main({ ...articleEvent, ARTICLE_PATH_PREFIX: undefined })

    expect(sendEmail).not.toHaveBeenCalled()
    expect(response.body.message).toBe('skipped - not an article page')
  })

  test('processes but skips the send when SENDGRID_API_KEY is missing', async () => {
    const response = await action.main({ ...articleEvent, SENDGRID_API_KEY: undefined })

    expect(sendEmail).not.toHaveBeenCalled()
    expect(response.statusCode).toBe(200)
    expect(response.body.message).toBe('processed')
    expect(response.body.emailResult).toEqual({ skipped: true })
  })

  test('returns 500 and logs the error if the send throws', async () => {
    const fakeError = new Error('sendgrid boom')
    sendEmail.mockRejectedValue(fakeError)

    const response = await action.main(articleEvent)

    expect(response.statusCode).toBe(500)
    expect(response.body.error).toBe('sendgrid boom')
    expect(mockLoggerInstance.error).toHaveBeenCalledWith(fakeError)
  })
})
