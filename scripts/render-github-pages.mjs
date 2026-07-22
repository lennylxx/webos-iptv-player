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

await writeFile(outputPath, pageHtml);
