import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const [inputPath = 'README.md', outputPath = '_site/index.html'] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY || 'lennylxx/webos-iptv-player';
const branch = process.env.GITHUB_REF_NAME || 'main';
const pagesBaseUrl = (
  process.env.GITHUB_PAGES_BASE_URL
  || `https://${repository.split('/')[0]}.github.io/${repository.split('/')[1]}/`
).replace(/\/?$/, '/');
const token = process.env.GITHUB_TOKEN;
const markdown = await readFile(inputPath, 'utf8');
const attachmentUrls = Array.from(new Set(
  markdown.match(/https:\/\/github\.com\/user-attachments\/assets\/[a-z0-9-]+/gi) || [],
));

const response = await fetch('https://api.github.com/markdown', {
  method: 'POST',
  headers: {
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'X-GitHub-Api-Version': '2022-11-28',
  },
  body: JSON.stringify({
    text: markdown,
    mode: 'gfm',
    context: repository,
  }),
});

if (!response.ok) {
  throw new Error(`GitHub Markdown API returned ${response.status}: ${await response.text()}`);
}

let pageHtml = await response.text();

pageHtml = pageHtml
  .replaceAll('<br>\n', '\n')
  .replaceAll(
    '<table role="table">',
    '<table role="table" style="width:100%;table-layout:fixed">',
  )
  .replace(
    /href="(?![a-z][a-z0-9+.-]*:|#|\/)([^"]+)"/gi,
    `href="https://github.com/${repository}/blob/${branch}/$1"`,
  )
  .replace(
    /src="(?![a-z][a-z0-9+.-]*:|\/)([^"]+)"/gi,
    `src="https://raw.githubusercontent.com/${repository}/${branch}/$1"`,
  );

const outputDirectory = dirname(outputPath);
const screenshotsDirectory = `${outputDirectory}/screenshots`;
await mkdir(outputDirectory, { recursive: true });
await mkdir(screenshotsDirectory, { recursive: true });

for (const attachmentUrl of attachmentUrls) {
  const id = attachmentUrl.slice(attachmentUrl.lastIndexOf('/') + 1);
  const matches = Array.from(new Set(
    Array.from(
      pageHtml.matchAll(new RegExp(`https://private-user-images\\.githubusercontent\\.com/[^"\\s<]*${id}[^"\\s<]*`, 'gi')),
      (match) => match[0],
    ),
  ));

  if (matches.length === 0) {
    throw new Error(`Rendered screenshot URL not found for ${id}`);
  }

  const downloadUrl = matches[0].replaceAll('&amp;', '&');
  const imageResponse = await fetch(downloadUrl);
  if (!imageResponse.ok) {
    throw new Error(`Screenshot download returned ${imageResponse.status} for ${id}`);
  }

  const extension = downloadUrl.match(new RegExp(`${id}\\.([a-z0-9]+)(?:\\?|&|$)`, 'i'))?.[1] || 'png';
  const relativePath = `screenshots/${id}.${extension}`;
  const publishedUrl = `${pagesBaseUrl}${relativePath}`;
  await writeFile(`${outputDirectory}/${relativePath}`, Buffer.from(await imageResponse.arrayBuffer()));

  for (const renderedUrl of matches) {
    pageHtml = pageHtml.replaceAll(renderedUrl, publishedUrl);
  }
}

const pageDocument = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>webOS IPTV Player</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #1f2328;
      background: #fff;
      font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: 100%;
      max-width: 1056px;
      margin: 0 auto;
      padding: 32px 24px;
    }
    h1, h2 {
      padding-bottom: .3em;
      border-bottom: 1px solid #d0d7de;
    }
    a { color: #0969da; }
    pre {
      max-width: 100%;
      padding: 16px;
      overflow-x: auto;
      background: #f6f8fa;
      border-radius: 6px;
    }
    code {
      padding: .2em .4em;
      background: #eff1f3;
      border-radius: 6px;
    }
    pre code {
      padding: 0;
      background: transparent;
    }
    markdown-accessiblity-table {
      display: block;
      max-width: 100%;
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 6px 13px;
      border: 1px solid #d0d7de;
    }
    tr:nth-child(2n) { background: #f6f8fa; }
    @media (max-width: 600px) {
      main { padding: 20px 16px; }
    }
  </style>
</head>
<body>
  <main>
${pageHtml}
  </main>
</body>
</html>
`;

await writeFile(outputPath, pageDocument);
