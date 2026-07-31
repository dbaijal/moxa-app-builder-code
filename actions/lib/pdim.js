/*
* <license header>
*/

/**
 * Normalization layer for the real Moxa PDIM product API.
 * Turns the raw API response (DITA-XML overview topics, JSON-stringified spec
 * items, a malformed "feature" field, cvisible-flagged duplicate specs) into
 * clean, presentation-agnostic JSON - so that whenever the real HTML/section
 * mapping arrives, populating it is a simple field lookup, not another round
 * of API-shape archaeology.
 *
 * Shared across actions (data-provider, series-cf-trigger) - both need the
 * same series/model lookup (data-provider to render pages, series-cf-trigger
 * to determine which pages to preview/publish when a series CF changes).
 */

function slugify (name) {
  return name.trim().toLowerCase().replace(/\s+/g, '-')
}

// The API's "feature" field has a known data bug: a stray trailing quote
// after the closing brace/bracket, which breaks JSON.parse outright.
function defensiveJsonParse (str) {
  try {
    return JSON.parse(str)
  } catch (error) {
    const lastBrace = Math.max(str.lastIndexOf('}'), str.lastIndexOf(']'))
    if (lastBrace === -1) throw error
    return JSON.parse(str.slice(0, lastBrace + 1))
  }
}

function decodeEntities (str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&ndash;/g, '–')
    .replace(/&deg;/g, '°')
}

function stripTags (str) {
  return decodeEntities(str.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function extractTag (xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`))
  return match ? match[1] : null
}

function extractAllTags (xml, tagName) {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'g')
  const results = []
  let match
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1])
  }
  return results
}

// A single "overview" entry is a DITA-style XML topic: <title> is the
// section heading, <body><p>...</p></body> holds one or more paragraphs.
function parseOverviewTopic (topicXml) {
  const heading = stripTags(extractTag(topicXml, 'title') || '')
  const body = extractTag(topicXml, 'body') || ''
  const text = extractAllTags(body, 'p').map(stripTags).filter(Boolean)
  return { heading, text }
}

// Bullet text may embed a footnote as <fn>...</fn> - captured separately
// rather than deciding now whether it should be shown inline or dropped.
function parseFeatureEntry (entry) {
  const footnoteMatch = entry.match(/<fn>([\s\S]*?)<\/fn>/)
  const footnote = footnoteMatch ? stripTags(footnoteMatch[1]) : null
  const text = stripTags(entry.replace(/<fn>[\s\S]*?<\/fn>/, ''))
  return { text, footnote }
}

function parseFeatureList (featureJsonString) {
  if (!featureJsonString) return []
  const parsed = defensiveJsonParse(featureJsonString)
  return (parsed.feature || []).map(parseFeatureEntry)
}

// Each spec's itemList is itself a JSON string. cvisible === "N" marks
// internal/derived duplicate rows that should not be shown. Rows are grouped
// by category (each becoming one row on the real page's accordion), in the
// order categories first appear - matches the real page's section order.
function parseSpecs (specsArray) {
  const rows = (specsArray || [])
    .map((spec) => {
      const item = defensiveJsonParse(spec.itemList)
      if (item.cvisible !== 'Y') return null
      return { category: spec.category, key: item.ckey, text: item.cvalue }
    })
    .filter(Boolean)

  const byCategory = new Map()
  rows.forEach(({ category, key, text }) => {
    if (!byCategory.has(category)) byCategory.set(category, [])
    byCategory.get(category).push({ key, text })
  })

  return Array.from(byCategory, ([category, items]) => ({ category, items }))
}

function findImage (attachments, subType) {
  const attachment = (attachments || []).find((a) => a.type === 'IMAGE' && a.subType === subType)
  return attachment?.damAsset?.assetPublicUrl || null
}

// Same idea as findImage, but returns every match (image gallery,
// certification logos) instead of just the first one.
function findImages (attachments, subType) {
  return (attachments || [])
    .filter((a) => a.type === 'IMAGE' && a.subType === subType && a.disabled !== 'Y')
    .map((a) => a.damAsset?.assetPublicUrl)
    .filter(Boolean)
}

// releaseDate comes as e.g. "2026-06-01 16:00:00.0000000 +00:00" - pull the
// YYYY-MM-DD prefix out directly rather than trusting Date to parse that
// whole nonstandard string, then format as "June 1, 2026" to match the page.
function formatDate (dateString) {
  if (!dateString) return null
  const match = dateString.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  const [, year, month, day] = match
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

// Everything that isn't an IMAGE attachment (datasheets, QIGs, software
// packages, ...) - the "resource" tab on the real page, one row each.
function findResources (attachments) {
  return (attachments || [])
    .filter((a) => a.type !== 'IMAGE' && a.disabled !== 'Y')
    .map((a) => ({
      name: a.name,
      type: a.type,
      subType: a.subType,
      version: a.version,
      releaseDate: formatDate(a.releaseDate),
      assetLink: a.damAsset?.assetPublicUrl || null,
    }))
}

// "prodModel" is a full HTML <table> comparing every model variant in the
// series (24 for EDS-4008) - a <thead> row of model-name columns, then one
// <tbody> row per spec (including Operating Voltage/Power Module/Operating
// Temp, which don't exist anywhere in the structured per-model specs data).
// Parsed row-oriented (not transposed to per-model columns) because that's
// the table's native shape and the real page renders it as an actual
// <table> - mirroring it means the HTML template needs no reshaping at all.
function parseProdModelTable (prodModelHtml) {
  if (!prodModelHtml) return { modelNames: [], rows: [] }

  const thead = extractTag(prodModelHtml, 'thead') || ''
  const headerCells = extractAllTags(thead, 'td').map(stripTags)
  const modelNames = headerCells.slice(1) // drop the "Model Name" label cell

  const tbody = extractTag(prodModelHtml, 'tbody') || ''
  const rows = extractAllTags(tbody, 'tr').map((rowHtml) => {
    const cells = extractAllTags(rowHtml, 'td').map(stripTags)
    const [key, ...values] = cells
    return { key, values }
  })

  return { modelNames, rows }
}

// Shaped to match the real series page section-by-section (banner, image
// gallery, features, certification logos), so populating the real HTML is a
// direct field lookup per section rather than another data-wrangling pass.
function normalizeSeries (rawSeries) {
  const seriesSlug = slugify(rawSeries.seriesName)
  const { modelNames, rows } = parseProdModelTable(rawSeries.prodModel)

  // Only models the API actually has structured data for (rawSeries.models)
  // get a link - the rest exist only as comparison-table columns for now.
  const modelSlugsWithData = new Set((rawSeries.models || []).map((m) => slugify(m.modelName)))
  const columns = modelNames.map((modelName) => {
    const slug = slugify(modelName)
    const hasData = modelSlugsWithData.has(slug)
    return { modelName, slug, link: hasData ? `/en/products/${seriesSlug}/${slug}` : null }
  })

  return {
    slug: seriesSlug,
    seriesId: rawSeries.seriesId,
    banner: {
      heading: rawSeries.seriesName,
      description: rawSeries.description,
    },
    images: findImages(rawSeries.attachments, 'SERIES'),
    // Footnotes dropped here per the real page - the fuller {text, footnote}
    // detail is still available from parseFeatureList() if ever needed.
    features: parseFeatureList(rawSeries.feature).map((f) => f.text),
    certifications: findImages(rawSeries.attachments, 'CERTIFICATION'),
    resources: findResources(rawSeries.attachments),
    // totalModels matches the "Available models (N)" count on the real page.
    modelComparison: { totalModels: columns.length, columns, rows },
    // Not yet mapped to a section on the real page - kept for later sections.
    overview: (rawSeries.overviews || []).map((o) => parseOverviewTopic(o.topic)),
    specs: parseSpecs(rawSeries.specs),
  }
}

// rawSeries is the parent series' raw API object - passed through so the
// model page can show/link back to its series (name + path), not just carry
// the slug string.
function normalizeModel (rawModel, rawSeries) {
  const seriesSlug = slugify(rawSeries.seriesName)
  return {
    slug: slugify(rawModel.modelName),
    modelId: rawModel.modelId,
    modelName: rawModel.modelName,
    series: {
      name: rawSeries.seriesName,
      slug: seriesSlug,
      link: `/en/products/${seriesSlug}`,
    },
    description: rawModel.description,
    heroImage: findImage(rawModel.attachments, 'MODEL'),
    specs: parseSpecs(rawModel.specs),
  }
}

// Cache-busting timestamp: the API's hostname is an Azure Front Door domain,
// which may cache responses the same way the AEM dispatcher did for GraphQL.
async function fetchProductList ({ PDIM_API_BASE_URL, PDIM_API_KEY }) {
  const url = `${PDIM_API_BASE_URL}/api/product?ts=${Date.now()}`
  const res = await fetch(url, { headers: { 'X-API-KEY': PDIM_API_KEY } })
  if (!res.ok) {
    const error = new Error(`PDIM API call failed: HTTP ${res.status}`)
    error.fetchFailed = true
    throw error
  }
  const json = await res.json()
  return json.data || []
}

module.exports = {
  slugify,
  defensiveJsonParse,
  parseOverviewTopic,
  parseFeatureList,
  parseSpecs,
  normalizeSeries,
  normalizeModel,
  fetchProductList,
}
