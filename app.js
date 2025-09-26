import express from 'express';
import puppeteer from 'puppeteer-core';
import { v4 as uuidv4 } from 'uuid';

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const BROWSER_WS = process.env.BROWSER_WS;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36';


// --- STATE MANAGEMENT ---
const tasks = {};

// --- THE SCRAPER FUNCTION ---
async function performScraping(taskId, url) {
  console.log(`[${taskId}] Starting scrape for: ${url}`);
  let browser;
  let page;
  
  const maxRetries = 3;
  let lastError = null;

  // --- Retry loop for connection and navigation ---
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Standardize the URL
      let standardizedUrl = url;
      try {
        const urlObject = new URL(url);
        if (urlObject.hostname.endsWith('aliexpress.com')) {
          urlObject.hostname = 'www.aliexpress.com';
          standardizedUrl = urlObject.toString();
        }
      } catch (e) {
        console.error(`[${taskId}] Could not parse URL, using original.`);
      }

      console.log(`[${taskId}] Attempt ${attempt}/${maxRetries}: Connecting to Bright Data browser...`);
      browser = await puppeteer.connect({
        browserWSEndpoint: BROWSER_WS,
        defaultViewport: { width: 1366, height: 768 }
      });

      page = await browser.newPage();
      await page.setUserAgent(USER_AGENT);
      
      const urlWithParams = `${standardizedUrl}${standardizedUrl.includes('?') ? '&' : '?'}currency=USD&ship_to=US`;
      console.log(`[${taskId}] Navigating to: ${urlWithParams}`);
      await page.goto(urlWithParams, { waitUntil: 'domcontentloaded', timeout: 120000 });
      
      // --- Check for fake 404 page after loading ---
      const bodyHtml = await page.evaluate(() => document.body.innerHTML);
      if (bodyHtml.includes('Sorry, the page you requested can not be found')) {
          console.warn(`[${taskId}] Detected a 404 page on attempt ${attempt}. This is likely a temporary block.`);
          throw new Error('AliExpress served a temporary 404 page.'); // This will trigger the catch block for a retry
      }
      
      console.log(`[${taskId}] Successfully connected and navigated on attempt ${attempt}.`);
      lastError = null; // Clear last error on success
      break; // Exit retry loop on success

    } catch (err) {
      lastError = err;
      console.error(`[${taskId}] Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
      if (browser) {
        await browser.close();
      }
      if (attempt < maxRetries) {
        console.log(`[${taskId}] Waiting 10 seconds before retrying...`);
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
    }
  }

  // If all retries failed, lastError will not be null
  if (lastError) {
      console.error(`[${taskId}] All connection attempts failed. Failing task.`);
      tasks[taskId].status = 'failed';
      tasks[taskId].error = `All connection attempts failed. Last error: ${lastError.message}`;
      return; // Stop execution
  }

  // --- Main scraping logic starts here, only if connection was successful ---
  try {
    console.log(`[${taskId}] Waiting for product info to load...`);
    try {
      await page.waitForSelector('[class*="sku--wrap"]', { timeout: 110000 });
    } catch(e) {
        console.error(`[${taskId}] CRITICAL: Timed out waiting for main product info.`);
        const screenshotBuffer = await page.screenshot({ encoding: 'base64' });
        console.error(`[${taskId}] Screenshot on failure (base64): data:image/png;base64,${screenshotBuffer}`);
        throw e;
    }

    // --- REVISED: More direct lazy-loading handler for description ---
    console.log(`[${taskId}] Attempting to reveal description by clicking navigation link...`);
    try {
        const descriptionNavLinkSelector = 'a[href="#nav-description"]';
        await page.waitForSelector(descriptionNavLinkSelector, { timeout: 5000 });
        await page.click(descriptionNavLinkSelector);
        console.log(`[${taskId}] Clicked description navigation link.`);

        // After clicking, wait for an image to appear inside the target section.
        const imageSelectorInDescription = '#nav-description img';
        await page.waitForSelector(imageSelectorInDescription, { timeout: 10000 });
        console.log(`[${taskId}] Images successfully loaded in description.`);
    } catch (e) {
        console.warn(`[${taskId}] Warning: Could not click description link or find images after clicking. This product might have a different layout or no description images. Error: ${e.message}`);
    }


    console.log(`[${taskId}] Product details loaded. Starting data extraction.`);

    const pageData = await page.evaluate(() => {
        const getText = (selector) => document.querySelector(selector)?.innerText.trim() || null;
        const getHtml = (selector) => document.querySelector(selector)?.outerHTML || null;
        // --- Robust image URL cleaner function ---
        const cleanImageUrl = (url) => {
            if (!url) return null;
            return url.split('?')[0].replace(/_\d+x\d+q\d+\.jpg(?:_\.avif|\.webp)?$/, '');
        };

        const availableColors = Array.from(document.querySelectorAll('[class*="sku-item--image"]')).map(el => ({
            name: el.querySelector('img')?.alt || null,
            image: cleanImageUrl(el.querySelector('img')?.src),
            isSelected: el.classList.contains('sku-item--selected')
        }));
        
        const availableSizes = Array.from(document.querySelectorAll('[class*="sku-item--text"]')).map(el => ({
            size: el.title || el.innerText.trim(),
            isSelected: el.classList.contains('sku-item--selected')
        }));

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

        const descriptionSelectors = ['#product-description', '#nav-description', '[class*="description--wrap"]'];
        let descriptionContainer = null;
        for (const selector of descriptionSelectors) {
            descriptionContainer = document.querySelector(selector);
            if (descriptionContainer) break;
        }

        const descriptionImages = descriptionContainer 
            ? Array.from(descriptionContainer.querySelectorAll('img')).map(img => cleanImageUrl(img.src)) 
            : [];

        return {
            title: getText('h1[data-pl="product-title"]'),
            bulkPrice: getText('[class*="banner-promotion-enhance--text"]'),
            coupon: getText('[class*="coupon-block--content"]'),
            mainImages: Array.from(document.querySelectorAll('[class*="slider--img"] img')).map(img => cleanImageUrl(img.src)),
            availableColors,
            availableSizes,
            selectedColor: availableColors.find(c => c.isSelected)?.name || null,
            selectedSize: availableSizes.find(s => s.isSelected)?.size || null,
            specifications,
            description: {
                text: [],
                images: descriptionImages,
            },
            productHTML: getHtml('.pdp-info'),
        };
    });
    
    // --- Fallback for description images ---
    if (pageData.description.images.length === 0 && pageData.mainImages.length > 0) {
        console.log(`[${taskId}] No images found in description. Using main product images as a fallback.`);
        pageData.description.images = pageData.mainImages;
    }
    
    console.log(`[${taskId}] Found ${pageData.description.images.length} total images for description.`);

    console.log(`[${taskId}] Extracting dynamic price variations...`);
    const priceVariations = [];
    const colorElements = await page.$$('[class*="sku-item--image"]');
    const sizeElements = await page.$$('[class*="sku-item--text"]');
    
    if (sizeElements.length > 0) {
        console.log(`[${taskId}] Found ${colorElements.length} colors and ${sizeElements.length} sizes. Using nested loop.`);
        for (const colorEl of colorElements) {
            await colorEl.click();
            await new Promise(resolve => setTimeout(resolve, 300));
            const currentColorName = await colorEl.$eval('img', img => img.alt);

            for (const sizeEl of sizeElements) {
                await sizeEl.click();
                
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
    } else if (colorElements.length > 0) {
        console.log(`[${taskId}] Found ${colorElements.length} colors and no sizes. Using single loop.`);
        for (const colorEl of colorElements) {
            await colorEl.click();
            await new Promise(resolve => setTimeout(resolve, 500));
            const currentColorName = await colorEl.$eval('img', img => img.alt);
            
            const variationData = await page.evaluate(() => {
                const getText = (selector) => document.querySelector(selector)?.innerText.trim() || null;
                return {
                    currentPrice: getText('.price-default--current--F8OlYIo'),
                    originalPrice: getText('.price-default--original--CWcHOit'),
                    discount: getText('.price-default--bannerSupplementary--o399nvO'),
                };
            });

            priceVariations.push({
                color: currentColorName,
                size: null,
                ...variationData
            });
        }
    } else {
        console.log(`[${taskId}] No product variations found. Extracting main price only.`);
        const mainPriceData = await page.evaluate(() => {
             const getText = (selector) => document.querySelector(selector)?.innerText.trim() || null;
             return {
                 currentPrice: getText('.price-default--current--F8OlYIo'),
                 originalPrice: getText('.price-default--original--CWcHOit'),
                 discount: getText('.price-default--bannerSupplementary--o399nvO'),
             };
        });
        priceVariations.push({
            color: null,
            size: null,
            ...mainPriceData
        });
    }
    
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
        storeInfo: {},
        coupon: pageData.coupon,
        video: null,
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
    console.error(`[${taskId}] Error during scraping logic:`, err.message);
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