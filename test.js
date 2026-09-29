const axios = require("axios");
const cheerio = require("cheerio");

require("dotenv").config();

const JOB_SEARCH_URL = "https://www.onlinejobs.ph/jobseekers/jobsearch";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Download the public OnlineJobs page.
async function getJobPage() {
    const response = await axios.get(JOB_SEARCH_URL, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/153.0.0.0 Safari/537.36",
            Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 30000,
    });

    return response.data;
}

// Extract job titles, dates, IDs, and URLs.
function extractJobs(html) {
    const $ = cheerio.load(html);
    const jobs = [];

    $(".jobpost-cat-box").each((index, element) => {
        const card = $(element);

        // Find the actual job link inside the card.
        let href = "";

        card.find("a").each((i, link) => {
            const linkHref = $(link).attr("href");

            if (
                !href &&
                linkHref &&
                linkHref.includes("/jobseekers/job/")
            ) {
                href = linkHref;
            }
        });

        // Skip anything that is not a job card.
        if (!href) {
            return;
        }

        // Create the full job URL.
        const url = new URL(
            href,
            "https://www.onlinejobs.ph"
        ).href;

        // Extract the numeric job ID.
        const jobIdMatch = href.match(/-(\d+)$/);

        const id = jobIdMatch
            ? jobIdMatch[1]
            : href;

        // Get all visible text from the card.
        const cardText = card
            .text()
            .replace(/\s+/g, " ")
            .trim();

        // Get links inside the job card.
        const links = card
            .find("a")
            .map((i, link) => ({
                text: $(link)
                    .text()
                    .replace(/\s+/g, " ")
                    .trim(),

                href: $(link).attr("href") || "",
            }))
            .get();

        // Find the job title.
        let title = "";

        for (const link of links) {
            if (
                link.text &&
                link.href.includes("/jobseekers/job/") &&
                link.text.length > 3
            ) {
                title = link.text;
                break;
            }
        }

        // Try to detect the posted date/time.
        let date = "";

        const dateMatch = cardText.match(
            /(?:Today|Yesterday|\d+\s+(?:minute|minutes|hour|hours|day|days|week|weeks)\s+ago|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,\s*\d{4})?)/i
        );

        if (dateMatch) {
            date = dateMatch[0];
        }

        jobs.push({
            id,
            title: title || "Untitled",
            date: date || "Date not detected",
            url,
        });
    });

    return jobs;
}

// Send a message to Telegram.
async function sendTelegramMessage(message) {
    const url =
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    await axios.post(url, {
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        disable_web_page_preview: false,
    });
}

// Main program.
async function main() {
    console.log("Checking OnlineJobs...");

    // Check Telegram configuration.
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        throw new Error(
            "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env"
        );
    }

    // Download OnlineJobs HTML.
    const html = await getJobPage();

    console.log("Page downloaded.");
    console.log(`HTML length: ${html.length}`);
    console.log("");

    // Extract jobs.
    const jobs = extractJobs(html);

    console.log(`Found ${jobs.length} jobs.`);
    console.log("");

    if (jobs.length === 0) {
        console.log("No jobs found.");
        return;
    }

    console.log("Sending jobs to Telegram...");
    console.log("");

    // Send each job to Telegram.
    for (const job of jobs.slice(0,3)) {
        const message = [
            "🚀 ONLINEJOBS NEW JOB",
            "",
            `💼 ${job.title}`,
            "",
            `📅 ${job.date}`,
            `🆔 ${job.id}`,
            "",
            `🔗 ${job.url}`,
        ].join("\n");

        try {
            await sendTelegramMessage(message);

            console.log(`Sent: ${job.title}`);

            // Small delay between messages.
            await new Promise((resolve) => setTimeout(resolve, 500));
        } catch (error) {
            console.error(
                `Telegram error for "${job.title}":`
            );

            console.error(
                error.response?.data || error.message
            );
        }
    }

    console.log("");
    console.log("Finished sending jobs to Telegram.");
}

// Start the program.
main().catch((error) => {
    console.error("ERROR:");
    console.error(error.response?.data || error.message);

    process.exit(1);
});