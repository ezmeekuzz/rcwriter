// Builds a downloadable SQL INSERT for an article on a non-WordPress site.
// It learns the database structure from the site's memory (an uploaded schema /
// export and the categories), and embeds images as base64 data URIs in the
// content so the SQL is self-contained. The AI writes SQL that matches the
// schema it is shown; always review the file before importing.
const fs = require('fs');
const path = require('path');

function stripFences(s) {
  let t = String(s || '').trim();
  // Remove a leading ```sql / ``` fence and a trailing ``` if present.
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  return t;
}

function createSqlExport({ ai, memoryText }) {
  // article: { title, excerpt, html, slug }, featuredDataUri: string|null
  async function build({ site, article, featuredDataUri }) {
    const memory = memoryText(site);
    if (!memory.trim()) {
      throw new Error(`Add this site's database structure to its Memory first (Websites → ${site.name} → Memory): upload an .sql export or a file listing the posts table columns and the categories with their ids. Without it, RCWriter can't build SQL that matches your database.`);
    }
    const content = featuredDataUri
      ? `<figure><img src="${featuredDataUri}" alt="${(article.title || '').replace(/"/g, '&quot;')}"></figure>\n${article.html || ''}`
      : (article.html || '');
    const system = 'You generate a single SQL INSERT (or the few INSERTs needed, e.g. a post plus a post-category link row) to add one article to the user\'s existing database. You are given the database structure. Match it exactly: real table names, real column names, and a real category id from the data provided. Output ONLY SQL — no explanation, no markdown fences. Use standard MySQL syntax, escape single quotes by doubling them, set the current date where a date is needed, and generate a URL slug from the title. Images are already embedded in the HTML as base64 data URIs — keep them in the content column as given. If something required is missing from the structure, add a SQL comment line (-- …) at the top saying what to check, then still produce your best INSERT.';
    const prompt = [
      `## Database structure and data for ${site.name} (from the site's memory)`,
      memory,
      '',
      '## The article to insert',
      `Title: ${article.title || ''}`,
      article.excerpt ? `Excerpt/meta: ${article.excerpt}` : '',
      `Suggested slug: ${article.slug || ''}`,
      '',
      'HTML content (images are base64 data URIs — keep them):',
      content,
      '',
      'Return only the SQL to insert this article into the database above, mapping it to the most appropriate real category id from the data. No commentary, no code fences.'
    ].filter(Boolean).join('\n');
    const r = await ai({ system, prompt, maxTokens: 8000 });
    const sql = stripFences(r.text);
    if (!/insert\s+into/i.test(sql)) throw new Error('The AI did not return a usable INSERT. Check the database structure in the site memory and try again.');
    return sql;
  }

  // Writes the SQL next to the article file and returns the path.
  function save(article, sql) {
    const file = String(article.path || '').replace(/\.md$/i, '') + '.sql';
    fs.writeFileSync(file, sql, 'utf8');
    return file;
  }

  return { build, save };
}

module.exports = { createSqlExport, stripFences };
