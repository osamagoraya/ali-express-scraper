import express from 'express';
import puppeteer from 'puppeteer-core';
import { v4 as uuidv4 } from 'uuid';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const BROWSER_WS = process.env.BROWSER_WS;

// --- STATE MANAGEMENT ---
const tasks = {};

// --- THE SCRAPER FUNCTION (Completely Rebuilt) ---
async function performScraping(taskId, url) {
  console.log(`[${taskId}] Starting scrape for: ${url}`);
  let browser;
  let page; 

  try {
    console.log(`[${taskId}] Connecting to Bright Data browser...`);
    browser = await puppeteer.connect({
      browserWSEndpoint: BROWSER_WS,
      defaultViewport: { width: 1366, height: 768 }
    });

    page = await browser.newPage();

    // --- FIX: Set currency and region via URL parameters ---
    // This is more reliable than setting cookies, which can be forbidden.
    const urlWithParams = `${url}${url.includes('?') ? '&' : '?'}currency=USD&ship_to=US`;
    console.log(`[${taskId}] Navigating to page with USD currency: ${urlWithParams}`);
    await page.goto(urlWithParams, { waitUntil: 'domcontentloaded', timeout: 120000 });

    console.log(`[${taskId}] Waiting for product details to load...`);
    await page.waitForSelector('[class*="sku--wrap"]', { timeout: 90000 });
    console.log(`[${taskId}] Product details loaded. Starting data extraction.`);

    // --- 1. EXTRACT ALL STATIC AND SEMI-STATIC DATA ---
    const pageData = await page.evaluate(() => {
        const getText = (selector) => document.querySelector(selector)?.innerText.trim() || null;
        const getHtml = (selector) => document.querySelector(selector)?.outerHTML || null;

        // Extract available colors with name, image, and selection state
        const availableColors = Array.from(document.querySelectorAll('[class*="sku-item--image"]')).map(el => ({
            name: el.querySelector('img')?.alt || null,
            image: el.querySelector('img')?.src.replace('_220x220q75.jpg_.avif', '') || null,
            isSelected: el.classList.contains('sku-item--selected')
        }));
        
        // Extract available sizes with size and selection state
        const availableSizes = Array.from(document.querySelectorAll('[class*="sku-item--text"]')).map(el => ({
            size: el.title || el.innerText.trim(),
            isSelected: el.classList.contains('sku-item--selected')
        }));

        // Extract specifications into a key-value object
        const specifications = {};
        document.querySelectorAll('[class*="specification--line"]').forEach(li => {
            const props = li.querySelectorAll('[class*="specification--prop"]');
            props.forEach(prop => {
                const title = prop.querySelector('[class*="specification--title"]')?.innerText.trim();
                const desc = prop.querySelector('[class*="specification--desc"]')?.innerText.trim();
                if (title && desc) {
                    specifications[title] = desc;
                }
            });
        });

        // Extract images from the description section
        const descriptionImages = Array.from(document.querySelectorAll('#product-description img')).map(img => img.src);

        return {
            title: getText('h1[data-pl="product-title"]'),
            bulkPrice: getText('[class*="banner-promotion-enhance--text"]'),
            coupon: getText('[class*="coupon-block--content"]'),
            mainImages: Array.from(document.querySelectorAll('[class*="slider--img"] img')).map(img => img.src.replace('_.avif', '')),
            availableColors,
            availableSizes,
            selectedColor: availableColors.find(c => c.isSelected)?.name || null,
            selectedSize: availableSizes.find(s => s.isSelected)?.size || null,
            specifications,
            description: {
                text: [], // As per your sample JSON
                images: descriptionImages,
            },
            productHTML: getHtml('.pdp-info'),
        };
    });
    
    // --- 2. DYNAMICALLY EXTRACT PRICE VARIATIONS ---
    console.log(`[${taskId}] Extracting dynamic price variations...`);
    const priceVariations = [];
    const colorElements = await page.$$('[class*="sku-item--image"]');
    const sizeElements = await page.$$('[class*="sku-item--text"]');
    
    for (const colorEl of colorElements) {
        await colorEl.click();
        await new Promise(resolve => setTimeout(resolve, 300)); // Wait for size options to update
        const currentColorName = await colorEl.$eval('img', img => img.alt);

        for (const sizeEl of sizeElements) {
            await sizeEl.click();
            
            // RELIABLE WAIT: Wait for the price to actually update in the DOM
            try {
                await page.waitForSelector('.price-default--current--F8OlYIo', { timeout: 5000 });
            } catch (e) {
                console.log(`[${taskId}] Price element did not appear for ${currentColorName}, skipping.`);
                continue;
            }

            const variationData = await page.evaluate(() => {
                const getText = (selector) => document.querySelector(selector)?.innerText.trim() || null;
                return {
                    currentPrice: getText('.price-default--current--F8OlYIo'),
                    originalPrice: getText('.price-default--original--CWcHOit'),
                    discount: getText('.price-default--bannerSupplementary--o399nvO'),
                };
            });

            const currentSizeName = await sizeEl.evaluate(el => el.title || el.innerText.trim());
            
            priceVariations.push({
                color: currentColorName,
                size: currentSizeName,
                ...variationData
            });
        }
    }
    
    // --- 3. ASSEMBLE THE FINAL DATA OBJECT ---
    const finalData = {
        title: pageData.title,
        currentPrice: priceVariations.length > 0 ? priceVariations[0].currentPrice : null,
        originalPrice: priceVariations.length > 0 ? priceVariations[0].originalPrice : null,
        discount: priceVariations.length > 0 ? priceVariations[0].discount : null,
        bulkPrice: pageData.bulkPrice,
        images: pageData.mainImages,
        priceVariations,
        selectedColor: pageData.selectedColor,
        availableColors: pageData.availableColors,
        selectedSize: pageData.selectedSize,
        availableSizes: pageData.availableSizes,
        storeInfo: {}, // As per your sample JSON
        coupon: pageData.coupon,
        video: null, // As per your sample JSON
        specifications: pageData.specifications,
        description: pageData.description,
        productHTML: pageData.productHTML
    };

    console.log(`[${taskId}] Scraping completed successfully!`);
    tasks[taskId] = {
      status: "completed",
      taskId,
      url,
      data: finalData,
      completedAt: new Date().toISOString(),
    };

  } catch (err) {
    console.error(`[${taskId}] Error during scraping:`, err.message);
    if (page) {
        const pageContent = await page.content();
        console.error(`[${taskId}] Page HTML on failure (first 2000 chars):`, pageContent.substring(0, 2000));
    }
    tasks[taskId].status = 'failed';
    tasks[taskId].error = err.message;
  } finally {
    if (browser) {
      await browser.close();
      console.log(`[${taskId}] Browser closed.`);
    }
  }
}

// --- API SETUP (Unchanged) ---
const app = express();
app.use(express.json());

app.get("/", (req, res) => {
    res.type('html').send("<h1>Scraper API is running!</h1><p>Send a POST request to /scrape to start a job.</p>");
});

app.post('/scrape', (req, res) => {
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

// --- SERVER INITIALIZATION (Unchanged) ---
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}. Access it through your public Render URL.`);
});

server.keepAliveTimeout = 120 * 1000;
server.headersTimeout = 120 * 1000;