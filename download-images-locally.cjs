/**
 * RUN THIS SCRIPT ON YOUR LOCAL MACHINE (not in Claude Code cloud)
 *
 * Prerequisites:
 *   npm install playwright
 *   npx playwright install chromium
 *
 * Usage:
 *   node download-images-locally.cjs
 *
 * This will:
 *   1. Visit every page on hotelgoldeneye.com
 *   2. Download ALL images (img tags, background images, lazy-loaded)
 *   3. Take full-page screenshots of every page
 *   4. Save all text content to scraped-content.json
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const BASE_URL = 'https://hotelgoldeneye.com';
const OUTPUT_DIR = path.join(__dirname, 'scraped');
const IMG_DIR = path.join(OUTPUT_DIR, 'images');
const SCREENSHOT_DIR = path.join(OUTPUT_DIR, 'screenshots');

fs.mkdirSync(IMG_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

function downloadImage(url, filepath) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redir = res.headers.location;
        if (redir.startsWith('/')) redir = new URL(redir, url).href;
        return downloadImage(redir, filepath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const stream = fs.createWriteStream(filepath);
      res.pipe(stream);
      stream.on('finish', () => { stream.close(); resolve(filepath); });
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    const h = document.body ? document.body.scrollHeight : 0;
    for (let i = 0; i < h; i += 300) {
      window.scrollTo(0, i);
      await delay(150);
    }
    window.scrollTo(0, 0);
    await delay(500);
  });
}

async function extractPageData(page) {
  return page.evaluate(() => {
    const getText = sel => Array.from(document.querySelectorAll(sel)).map(e => e.textContent.trim()).filter(Boolean);

    // All image sources including lazy-loaded
    const imgSrcs = new Set();
    document.querySelectorAll('img, source, [data-src], [data-lazy-src], [data-bg]').forEach(el => {
      ['src', 'data-src', 'data-lazy-src', 'data-bg', 'data-background-image'].forEach(attr => {
        const val = el.getAttribute(attr);
        if (val && !val.startsWith('data:')) imgSrcs.add(val);
      });
      const srcset = el.getAttribute('srcset');
      if (srcset) {
        srcset.split(',').forEach(s => {
          const url = s.trim().split(' ')[0];
          if (url && !url.startsWith('data:')) imgSrcs.add(url);
        });
      }
    });

    // Background images from computed styles
    const bgSrcs = new Set();
    document.querySelectorAll('*').forEach(el => {
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== 'none') {
        const matches = bg.match(/url\(["']?(.*?)["']?\)/g);
        if (matches) matches.forEach(m => {
          const url = m.replace(/url\(["']?/, '').replace(/["']?\)/, '');
          if (url && !url.startsWith('data:')) bgSrcs.add(url);
        });
      }
    });

    // Internal links
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ text: a.textContent.trim().substring(0, 100), href: a.href }))
      .filter(l => l.href.startsWith(window.location.origin));

    return {
      title: document.title,
      url: window.location.href,
      headings: { h1: getText('h1'), h2: getText('h2'), h3: getText('h3'), h4: getText('h4') },
      paragraphs: getText('p'),
      listItems: getText('li'),
      images: [...imgSrcs],
      bgImages: [...bgSrcs],
      links,
      fullText: (document.body || {}).innerText || '',
    };
  });
}

(async () => {
  console.log('Starting scraper for hotelgoldeneye.com...\n');

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });

  const page = await context.newPage();

  // Track all network image responses
  const networkImages = new Set();
  page.on('response', resp => {
    const ct = resp.headers()['content-type'] || '';
    if (ct.startsWith('image/') && !resp.url().startsWith('data:')) {
      networkImages.add(resp.url());
    }
  });

  // Step 1: Scrape homepage and discover pages
  console.log('=== STEP 1: Discovering pages ===');
  await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await autoScroll(page);
  await page.waitForTimeout(2000);

  const homeData = await extractPageData(page);
  console.log(`Homepage: ${homeData.title}`);
  console.log(`  Images: ${homeData.images.length}, BG Images: ${homeData.bgImages.length}`);

  // Discover all internal pages
  const pagesToScrape = new Map();
  pagesToScrape.set('homepage', BASE_URL);

  const processLinks = (links) => {
    for (const link of links) {
      const clean = link.href.split('#')[0].split('?')[0].replace(/\/$/, '');
      const slug = clean.replace(BASE_URL, '').replace(/^\//, '') || 'homepage';
      if (slug !== 'homepage' && !pagesToScrape.has(slug) && clean.startsWith(BASE_URL)) {
        pagesToScrape.set(slug, clean);
      }
    }
  };
  processLinks(homeData.links);

  // Also try common WordPress pages
  const commonPages = ['about', 'rooms', 'gallery', 'contact', 'restaurant', 'dining',
    'facilities', 'amenities', 'reservation', 'booking', 'services', 'events', 'menu'];
  for (const p of commonPages) {
    if (!pagesToScrape.has(p)) {
      pagesToScrape.set(p, `${BASE_URL}/${p}/`);
    }
  }

  console.log(`\nPages to scrape: ${pagesToScrape.size}`);
  console.log([...pagesToScrape.keys()].join(', '));

  // Step 2: Scrape all pages
  console.log('\n=== STEP 2: Scraping all pages ===');
  const allPages = { homepage: homeData };

  for (const [slug, url] of pagesToScrape) {
    if (slug === 'homepage') continue;
    console.log(`\nScraping: ${slug} (${url})`);
    try {
      const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      if (resp.status() === 404) {
        console.log(`  404 - skipping`);
        continue;
      }
      await autoScroll(page);
      await page.waitForTimeout(1500);
      const data = await extractPageData(page);
      allPages[slug] = data;
      console.log(`  Title: ${data.title}`);
      console.log(`  Images: ${data.images.length}, BG: ${data.bgImages.length}`);

      // Discover more links
      processLinks(data.links);
    } catch (e) {
      console.log(`  Error: ${e.message.substring(0, 100)}`);
    }
  }

  // Step 3: Screenshots
  console.log('\n=== STEP 3: Taking screenshots ===');
  for (const [slug, url] of pagesToScrape) {
    if (!allPages[slug]) continue;
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await autoScroll(page);
      await page.waitForTimeout(1000);
      const ssPath = path.join(SCREENSHOT_DIR, `${slug.replace(/\//g, '-')}.png`);
      await page.screenshot({ path: ssPath, fullPage: true });
      console.log(`  Screenshot: ${slug}`);
    } catch (e) {
      console.log(`  Screenshot failed: ${slug}`);
    }
  }

  // Step 4: Download all images
  console.log('\n=== STEP 4: Downloading images ===');
  const allImageUrls = new Set();

  for (const [, pageData] of Object.entries(allPages)) {
    if (!pageData) continue;
    pageData.images.forEach(u => allImageUrls.add(u));
    pageData.bgImages.forEach(u => allImageUrls.add(u));
  }
  networkImages.forEach(u => allImageUrls.add(u));

  // Resolve relative URLs
  const resolved = new Set();
  for (const u of allImageUrls) {
    if (u.startsWith('http')) resolved.add(u);
    else if (u.startsWith('//')) resolved.add('https:' + u);
    else if (u.startsWith('/')) resolved.add(BASE_URL + u);
    else resolved.add(BASE_URL + '/' + u);
  }

  console.log(`Total unique images: ${resolved.size}`);
  let downloaded = 0, failed = 0;

  for (const imgUrl of resolved) {
    try {
      const urlObj = new URL(imgUrl);
      let filename = decodeURIComponent(path.basename(urlObj.pathname))
        .split('?')[0]
        .replace(/[^a-zA-Z0-9._-]/g, '_');
      if (!filename || filename.length < 3) filename = `image_${downloaded + 1}.jpg`;
      if (filename.length > 120) filename = filename.substring(0, 120);

      let finalPath = path.join(IMG_DIR, filename);
      let counter = 1;
      while (fs.existsSync(finalPath)) {
        const ext = path.extname(filename);
        const base = path.basename(filename, ext);
        finalPath = path.join(IMG_DIR, `${base}_${counter}${ext}`);
        counter++;
      }

      await downloadImage(imgUrl, finalPath);
      const size = fs.statSync(finalPath).size;
      if (size < 100) { fs.unlinkSync(finalPath); continue; } // skip tiny/empty files
      downloaded++;
      console.log(`  [${downloaded}] ${filename} (${(size / 1024).toFixed(1)}KB)`);
    } catch (e) {
      failed++;
    }
  }

  console.log(`\n=== COMPLETE ===`);
  console.log(`Pages scraped: ${Object.keys(allPages).length}`);
  console.log(`Screenshots taken: ${fs.readdirSync(SCREENSHOT_DIR).length}`);
  console.log(`Images downloaded: ${downloaded}`);
  console.log(`Images failed: ${failed}`);

  // Save all content
  const outputPath = path.join(OUTPUT_DIR, 'scraped-content.json');
  fs.writeFileSync(outputPath, JSON.stringify(allPages, null, 2));
  console.log(`\nContent saved to: ${outputPath}`);
  console.log(`Images saved to: ${IMG_DIR}`);
  console.log(`Screenshots saved to: ${SCREENSHOT_DIR}`);

  await browser.close();
})();
