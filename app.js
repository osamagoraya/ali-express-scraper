import express from 'express';
import puppeteer from 'puppeteer-core';
import { v4 as uuidv4 } from 'uuid';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
// IMPORTANT: Your secret WebSocket URL is now loaded from an environment variable
const BROWSER_WS = process.env.BROWSER_WS;

// --- STATE MANAGEMENT ---
// In-memory task storage is perfect for this use case.
const tasks = {};

// --- THE SCRAPER FUNCTION (Your logic, unchanged) ---
async function performScraping(taskId, url) {
  console.log(`[${taskId}] Starting scrape for: ${url}`);
  let browser;

  try {
    console.log(`[${taskId}] Connecting to Bright Data browser...`);
    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSER_WS,
      defaultViewport: { width: 1280, height: 1024 }
    });

    const page = await browser.newPage();
    console.log(`[${taskId}] Navigating to page...`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

    console.log(`[${taskId}] Waiting for product details to load...`);
    await page.waitForSelector('.sku-item--wrap--xgoW06M', { timeout: 60000 });

    const priceVariations = [];
    const colorElements = await page.$$('.sku-item--image--jMUnnGA');
    const sizeElements = await page.$$('.sku-item--text--hYfAukP');

    console.log(`[${taskId}] Found ${colorElements.length} colors and ${sizeElements.length} sizes.`);

    for (const colorEl of colorElements) {
      await colorEl.click();
      await new Promise(resolve => setTimeout(resolve, 200));

      for (const sizeEl of sizeElements) {
        await sizeEl.click();
        await new Promise(resolve => setTimeout(resolve, 200));

        const variationData = await page.evaluate(() => {
          const getText = (selector) => document.querySelector(selector)?.innerText.trim() || null;
          return {
            color: getText('.sku-item--title--Z0HLO87 span:last-child'),
            size: getText('.sku-item--title--Z0HLO87 span:last-child'),
            currentPrice: getText('.price-default--current--F8OlYIo'),
            originalPrice: getText('.price-default--original--CWcHOit'),
            discount: getText('.price-default--bannerSupplementary--o399nvO'),
          };
        });
        variationData.size = await sizeEl.evaluate(el => el.innerText.trim());
        priceVariations.push(variationData);
      }
    }

    const staticData = await page.evaluate(() => {
        const getText = (selector) => document.querySelector(selector)?.innerText.trim() || null;
        const images = Array.from(document.querySelectorAll('.slider--img--kD4mIg7 img'))
          .map(img => img.src.replace('_.avif', ''));
        return {
            title: getText('h1[data-pl="product-title"]'),
            images,
        };
    });

    console.log(`[${taskId}] Scraping completed successfully!`);
    tasks[taskId] = {
      status: "completed",
      taskId,
      url,
      data: { ...staticData, priceVariations },
      completedAt: new Date().toISOString(),
    };

  } catch (err) {
    console.error(`[${taskId}] Error during scraping:`, err.message);
    tasks[taskId].status = 'failed';
    tasks[taskId].error = err.message;
  } finally {
    if (browser) {
      await browser.close();
      console.log(`[${taskId}] Browser closed.`);
    }
  }
}

// --- API SETUP ---
const app = express();
app.use(express.json());

// Add a root route to easily check if the server is running
app.get("/", (req, res) => {
    res.type('html').send("<h1>Scraper API is running!</h1><p>Send a POST request to /scrape to start a job.</p>");
});

app.post('/scrape', (req, res) => {
  // Check if the BROWSER_WS is configured before starting a task
  if (!BROWSER_WS) {
    console.error("FATAL: BROWSER_WS environment variable is not set.");
    return res.status(500).json({ error: 'Server is not configured. Missing browser connection details.' });
  }

  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'Missing URL' });
  }

  const taskId = `task_${uuidv4()}`;
  tasks[taskId] = { status: 'pending', url, startedAt: new Date().toISOString(), data: null };

  // Run scraping in the background (don't await it here)
  performScraping(taskId, url);

  res.status(202).json({
    message: 'Scraping task accepted.',
    taskId,
    statusUrl: `/scrape/${taskId}`,
    estimatedCompletionTime: '2-3 minutes',
  });
});

app.get('/scrape/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = tasks[taskId];

  if (!task) {
    return res.status(404).json({ error: 'Task not found' });
  }
  res.json(task);
});

// --- SERVER INITIALIZATION ---
const server = app.listen(PORT, () => {
  // This log is now clearer for a deployed environment.
  console.log(`Server listening on port ${PORT}. Access it through your public Render URL.`);
});

// Settings from the Render example to handle long connections
server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 120 * 1000;

