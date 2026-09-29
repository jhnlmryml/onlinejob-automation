require("dotenv").config();

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const SEARCH_URL =
    "https://www.onlinejobs.ph/jobseekers/jobsearch";

const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
    process.env.TELEGRAM_CHAT_ID;

const REQUEST_DELAY = 4000;
const MAX_RETRIES = 3;

const SEEN_JOBS_FILE =
    path.join(__dirname, "seen-jobs.json");

const TARGET_KEYWORDS = [
    "virtual assistant",
    "va",
    "administrative assistant",
    "admin assistant",
    "admin support",
    "general virtual assistant",
    "gva",
    "remote assistant",
    "office assistant",
    "executive assistant",
    "executive va",
    "ea",
    "calendar management",
    "email management",
    "travel planning",
    "appointment setting",
    "inbox management",
    "data entry",
    "data entry specialist",
    "data management",
    "spreadsheet management",
    "google sheets",
    "excel",
    "data mining",
    "data processing",
    "web research",
    "amazon listing",
    "amazon va",
    "amazon virtual assistant",
    "e-commerce assistant",
    "ecommerce va",
    "product listing",
    "order processing",
    "inventory management",
    "product research",
    "supplier communication",
    "listing optimization",
];

/* ==================================================
   BASIC HELPERS
================================================== */

// Wait before making another request.
function delay(ms) {
    return new Promise((resolve) =>
        setTimeout(resolve, ms)
    );
}

// Clean normal text.
function cleanText(text) {
    return (text || "")
        .replace(/\u00a0/g, " ")
        .replace(/\r/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n")
        .trim();
}

// Clean extracted job content.
function cleanJobContent(text) {
    return (text || "")
        .replace(/\u00a0/g, " ")
        .replace(/\r/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n[ \t]+/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

// Normalize text for keyword matching.
function normalizeMatchText(text) {
    return (text || "")
        .toLowerCase()
        .replace(/[^\w\s.-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Escape special RegExp characters.
function escapeRegex(text) {
    return text.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
    );
}

/* ==================================================
   JOB TITLE
================================================== */

// Clean unwanted information from a job title.
function cleanJobTitle(title) {
    if (!title) {
        return "Untitled Job";
    }

    let cleaned =
        cleanText(title);

    cleaned =
        cleaned.replace(
            /\s+Posted on[\s\S]*$/i,
            ""
        );

    cleaned =
        cleaned.replace(
            /\s+(Full Time|Part Time|Any Type|Any)\s*$/i,
            ""
        );

    cleaned =
        cleaned.replace(
            /\s+\bTBD\b\s*$/i,
            ""
        );

    cleaned =
        cleaned.replace(
            /\s+\$[\d,]+(?:\.\d+)?(?:\s*-\s*\$[\d,]+(?:\.\d+)?)?(?:\+)?(?:\s*USD)?(?:\/month|\/hour)?\s*$/i,
            ""
        );

    return (
        cleaned.trim() ||
        "Untitled Job"
    );
}

/* ==================================================
   KEYWORD MATCHING
================================================== */

// Match complete words instead of substrings.
function containsKeyword(text, keyword) {
    const normalizedText =
        normalizeMatchText(text);

    const normalizedKeyword =
        normalizeMatchText(keyword);

    if (
        !normalizedText ||
        !normalizedKeyword
    ) {
        return false;
    }

    const escapedKeyword =
        escapeRegex(normalizedKeyword);

    const regex =
        new RegExp(
            `(^|\\s)${escapedKeyword}(?=\\s|$|[.,!?;:/()\\-])`,
            "i"
        );

    return regex.test(
        normalizedText
    );
}

/* ==================================================
   HTTP REQUEST
================================================== */

// Download a page with retry support.
async function getPage(url) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        try {
            const response =
                await axios.get(url, {
                    timeout: 30000,

                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",

                        "Accept":
                            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

                        "Accept-Language":
                            "en-US,en;q=0.9",

                        "Cache-Control":
                            "no-cache",

                        "Pragma":
                            "no-cache",
                    },
                });

            return response.data;
        } catch (error) {
            lastError = error;

            const status =
                error.response?.status;

            const retryAfter =
                error.response?.headers?.[
                    "retry-after"
                    ];

            /* ------------------------------------------
               RATE LIMIT
            ------------------------------------------ */

            if (status === 429) {
                const retrySeconds =
                    Number(retryAfter);

                const waitTime =
                    Number.isFinite(
                        retrySeconds
                    )
                        ? retrySeconds * 1000
                        : 15000 * attempt;

                console.log(
                    `Rate limited. Waiting ${Math.round(
                        waitTime / 1000
                    )} seconds...`
                );

                await delay(
                    waitTime
                );

                continue;
            }

            /* ------------------------------------------
               SERVER ERROR
            ------------------------------------------ */

            if (
                status >= 500 &&
                status <= 599
            ) {
                console.log(
                    `Server error ${status}. Retrying...`
                );

                await delay(
                    5000 * attempt
                );

                continue;
            }

            /* ------------------------------------------
               NETWORK ERROR
            ------------------------------------------ */

            if (
                error.code ===
                "ECONNRESET" ||
                error.code ===
                "ETIMEDOUT" ||
                error.code ===
                "ECONNABORTED"
            ) {
                console.log(
                    `Network error. Retrying attempt ${attempt}/${MAX_RETRIES}...`
                );

                await delay(
                    5000 * attempt
                );

                continue;
            }

            throw error;
        }
    }

    throw lastError;
}

/* ==================================================
   SEARCH PAGE
================================================== */

// Extract jobs from the search page.
function extractJobs(html) {
    const $ =
        cheerio.load(html);

    console.log(
        `Downloaded HTML length: ${html.length}`
    );

    console.log(
        `Page title: ${cleanText(
            $("title").text()
        )}`
    );

    console.log(
        `Job card count: ${$(
            ".jobpost-cat-box"
        ).length}`
    );

    console.log(
        `Job links count: ${$(
            'a[href*="/jobseekers/job/"]'
        ).length}`
    );

    const jobs = [];
    const seenIds = new Set();

    $(".jobpost-cat-box").each(
        function () {
            const card =
                $(this);

            const links =
                card.find(
                    'a[href*="/jobseekers/job/"]'
                );

            if (!links.length) {
                return;
            }

            let jobLink = null;

            links.each(
                function () {
                    if (jobLink) {
                        return;
                    }

                    const href =
                        $(this).attr(
                            "href"
                        );

                    if (
                        href &&
                        href.includes(
                            "/jobseekers/job/"
                        )
                    ) {
                        jobLink =
                            $(this);
                    }
                }
            );

            if (!jobLink) {
                return;
            }

            const href =
                jobLink.attr("href");

            if (!href) {
                return;
            }

            const url =
                href.startsWith("http")
                    ? href
                    : `https://www.onlinejobs.ph${href}`;

            /*
                Get all numbers from the URL.
                The last number is the job ID.
            */
            const idMatches =
                url.match(
                    /\d+/g
                );

            if (
                !idMatches ||
                !idMatches.length
            ) {
                return;
            }

            const id =
                idMatches[
                idMatches.length - 1
                    ];

            if (!id) {
                return;
            }

            /*
                Avoid duplicate job IDs.
            */
            if (
                seenIds.has(id)
            ) {
                return;
            }

            /* ------------------------------------------
               EXTRACT TITLE
            ------------------------------------------ */

            let title =
                cleanText(
                    jobLink.attr(
                        "title"
                    )
                );

            if (!title) {
                title =
                    cleanText(
                        card
                            .find(
                                "h1, h2, h3, h4, h5, h6"
                            )
                            .first()
                            .text()
                    );
            }

            if (!title) {
                title =
                    cleanText(
                        card
                            .find(
                                ".job-title, .title, .jobpost-title"
                            )
                            .first()
                            .text()
                    );
            }

            if (!title) {
                title =
                    cleanText(
                        jobLink.text()
                    );
            }

            title =
                cleanJobTitle(
                    title
                );

            if (
                !title ||
                title === "Untitled Job"
            ) {
                return;
            }

            seenIds.add(id);

            jobs.push({
                id,
                title,
                url,
            });
        }
    );

    return jobs;
}

/* ==================================================
   DETAIL PAGE TEXT
================================================== */

// Prepare the visible text from a job page.
function getVisiblePageText(html) {
    const $ =
        cheerio.load(html);

    /*
        Remove elements that should never
        be considered job content.
    */
    $(
        "script, style, noscript, iframe, svg"
    ).remove();

    $(
        "nav, footer, header"
    ).remove();

    $(
        ".share, .sharing, .social-share, .report-job, .view-report"
    ).remove();

    return cleanJobContent(
        $("body").text()
    );
}

/* ==================================================
   SECTION EXTRACTION
================================================== */

// Remove common footer/navigation garbage.
function cleanExtractedSection(text) {
    let result =
        cleanJobContent(text);

    const stopPatterns = [
        /VIEW OTHER JOB POSTS FROM:[\s\S]*$/i,
        /SHARE THIS POST[\s\S]*$/i,
        /Report\s*×[\s\S]*$/i,
        /Bookmark[\s\S]*$/i,
        /Why is this blurred\?[\s\S]*$/i,
        /For privacy and security reasons[\s\S]*$/i,
        /Employers\s+How it works[\s\S]*$/i,
        /Workers\s+How it works[\s\S]*$/i,
        /SPREAD THE WORD[\s\S]*$/i,
        /Copyright[\s\S]*$/i,
    ];

    for (
        const pattern of stopPatterns
        ) {
        result =
            result.replace(
                pattern,
                ""
            );
    }

    return cleanJobContent(
        result
    );
}

// Extract a section from visible page text.
function extractTextSection(
    text,
    startLabel,
    endLabels = []
) {
    if (!text) {
        return "";
    }

    const normalized =
        text
            .replace(/\u00a0/g, " ")
            .replace(/\r/g, "")
            .replace(/\n/g, " ")
            .replace(/\s+/g, " ")
            .trim();

    const startRegex =
        new RegExp(
            escapeRegex(
                startLabel
            ),
            "i"
        );

    const startMatch =
        startRegex.exec(
            normalized
        );

    if (!startMatch) {
        return "";
    }

    const startIndex =
        startMatch.index +
        startMatch[0].length;

    const remaining =
        normalized.slice(
            startIndex
        );

    let endIndex =
        remaining.length;

    for (
        const endLabel of endLabels
        ) {
        const endRegex =
            new RegExp(
                `\\s+${escapeRegex(
                    endLabel
                )}\\s*`,
                "i"
            );

        const match =
            endRegex.exec(
                remaining
            );

        if (
            match &&
            match.index <
            endIndex
        ) {
            endIndex =
                match.index;
        }
    }

    const result =
        remaining.slice(
            0,
            endIndex
        );

    return cleanExtractedSection(
        result
    );
}

/* ==================================================
   DOM SECTION FALLBACK
================================================== */

// Find a heading-like element containing the label.
function findSectionElement(
    $,
    label
) {
    const selectors = [
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "strong",
        "b",
        "div",
        "span",
        "p",
        "td",
        "th",
    ];

    let result = null;

    for (
        const selector of selectors
        ) {
        $(selector).each(
            function () {
                if (result) {
                    return;
                }

                const text =
                    cleanText(
                        $(this).text()
                    );

                if (
                    new RegExp(
                        `^${escapeRegex(
                            label
                        )}$`,
                        "i"
                    ).test(text)
                ) {
                    result =
                        $(this);
                }
            }
        );

        if (result) {
            break;
        }
    }

    return result;
}

// Extract section content from the DOM.
function extractDomSection(
    $,
    label,
    endLabels
) {
    const element =
        findSectionElement(
            $,
            label
        );

    if (
        !element ||
        !element.length
    ) {
        return "";
    }

    /*
        First try following siblings.
    */
    const parts = [];

    let current =
        element.next();

    while (
        current.length
        ) {
        const currentText =
            cleanText(
                current.text()
            );

        if (
            endLabels.some(
                (endLabel) =>
                    new RegExp(
                        `^${escapeRegex(
                            endLabel
                        )}$`,
                        "i"
                    ).test(
                        currentText
                    )
            )
        ) {
            break;
        }

        if (currentText) {
            parts.push(
                currentText
            );
        }

        current =
            current.next();
    }

    if (parts.length) {
        const result =
            cleanExtractedSection(
                parts.join("\n")
            );

        if (result) {
            return result;
        }
    }

    /*
        Try the parent container.
    */
    let parent =
        element.parent();

    for (
        let level = 0;
        level < 4 &&
        parent.length;
        level++
    ) {
        const clone =
            parent.clone();

        clone.find(
            "script, style, noscript, iframe, svg"
        ).remove();

        /*
            Remove the section label itself.
        */
        clone
            .find(
                "*"
            )
            .filter(
                function () {
                    return new RegExp(
                        `^${escapeRegex(
                            label
                        )}$`,
                        "i"
                    ).test(
                        cleanText(
                            $(this).text()
                        )
                    );
                }
            )
            .first()
            .remove();

        const result =
            cleanExtractedSection(
                clone.text()
            );

        if (
            result &&
            result.length > 10
        ) {
            return result;
        }

        parent =
            parent.parent();
    }

    return "";
}

/* ==================================================
   JOB DETAILS
================================================== */

// Extract overview, skills and job metadata.
function extractJobDetails(html) {
    const $ =
        cheerio.load(html);

    /*
        Get the visible page text before
        removing anything else.
    */
    const visibleText =
        getVisiblePageText(
            html
        );

    /* ----------------------------------------------
       JOB OVERVIEW
    ---------------------------------------------- */

    let overview =
        extractTextSection(
            visibleText,
            "JOB OVERVIEW",
            [
                "SKILL REQUIREMENT",
                "SKILL REQUIREMENTS",
                "JOB REQUIREMENT",
                "JOB REQUIREMENTS",
                "VIEW OTHER JOB POSTS FROM:",
                "SHARE THIS POST",
            ]
        );

    /*
        DOM fallback if text extraction
        did not find the section.
    */
    if (!overview) {
        overview =
            extractDomSection(
                $,
                "JOB OVERVIEW",
                [
                    "SKILL REQUIREMENT",
                    "SKILL REQUIREMENTS",
                ]
            );
    }

    if (!overview) {
        overview =
            "Not specified";
    }

    /* ----------------------------------------------
       SKILL REQUIREMENT
    ---------------------------------------------- */

    let skills =
        extractTextSection(
            visibleText,
            "SKILL REQUIREMENT",
            [
                "JOB OVERVIEW",
                "VIEW OTHER JOB POSTS FROM:",
                "SHARE THIS POST",
                "REPORT",
                "BOOKMARK",
            ]
        );

    if (!skills) {
        skills =
            extractTextSection(
                visibleText,
                "SKILL REQUIREMENTS",
                [
                    "JOB OVERVIEW",
                    "VIEW OTHER JOB POSTS FROM:",
                    "SHARE THIS POST",
                ]
            );
    }

    /*
        DOM fallback.
    */
    if (!skills) {
        skills =
            extractDomSection(
                $,
                "SKILL REQUIREMENT",
                [
                    "JOB OVERVIEW",
                ]
            );
    }

    if (!skills) {
        skills =
            extractDomSection(
                $,
                "SKILL REQUIREMENTS",
                [
                    "JOB OVERVIEW",
                ]
            );
    }

    if (!skills) {
        skills =
            "Not specified";
    }

    overview =
        cleanExtractedSection(
            overview
        );

    skills =
        cleanExtractedSection(
            skills
        );

    if (!overview) {
        overview =
            "Not specified";
    }

    if (!skills) {
        skills =
            "Not specified";
    }

    /* ----------------------------------------------
       JOB METADATA
    ---------------------------------------------- */

    let typeOfWork =
        "Not specified";

    let wage =
        "Not specified";

    let hoursPerWeek =
        "Not specified";

    let dateUpdated =
        "Not specified";

    /*
        Search common visible elements.
    */
    $(
        "li, p, td, th, dt, dd, div"
    ).each(function () {
        const element =
            $(this);

        /*
            Ignore large parent containers.
        */
        if (
            element.children(
                "div, section, table, ul, ol"
            ).length
        ) {
            return;
        }

        const text =
            cleanText(
                element.text()
            );

        if (!text) {
            return;
        }

        let match =
            text.match(
                /^Type of Work\s*:?\s*(.+)$/i
            );

        if (
            match &&
            match[1]
        ) {
            typeOfWork =
                cleanText(
                    match[1]
                );
        }

        match =
            text.match(
                /^Wage\s*\/?\s*Salary\s*:?\s*(.+)$/i
            );

        if (
            match &&
            match[1]
        ) {
            wage =
                cleanText(
                    match[1]
                );
        }

        match =
            text.match(
                /^Hours\s+per\s+Week\s*:?\s*(.+)$/i
            );

        if (
            match &&
            match[1]
        ) {
            hoursPerWeek =
                cleanText(
                    match[1]
                );
        }

        match =
            text.match(
                /^Date\s+Updated\s*:?\s*(.+)$/i
            );

        if (
            match &&
            match[1]
        ) {
            dateUpdated =
                cleanText(
                    match[1]
                );
        }
    });

    /* ----------------------------------------------
       TABLE FALLBACK
    ---------------------------------------------- */

    $("tr").each(
        function () {
            const cells =
                $(this)
                    .find(
                        "th, td"
                    )
                    .map(
                        function () {
                            return cleanText(
                                $(this).text()
                            );
                        }
                    )
                    .get();

            if (
                cells.length < 2
            ) {
                return;
            }

            const label =
                cells[0];

            const value =
                cells
                    .slice(1)
                    .join(" ");

            if (
                /^Type of Work$/i.test(
                    label
                )
            ) {
                typeOfWork =
                    value;
            }

            if (
                /^Wage\s*\/?\s*Salary$/i.test(
                    label
                )
            ) {
                wage =
                    value;
            }

            if (
                /^Hours\s+per\s+Week$/i.test(
                    label
                )
            ) {
                hoursPerWeek =
                    value;
            }

            if (
                /^Date\s+Updated$/i.test(
                    label
                )
            ) {
                dateUpdated =
                    value;
            }
        }
    );

    return {
        overview,
        skills,
        typeOfWork,
        wage,
        hoursPerWeek,
        dateUpdated,
    };
}

/* ==================================================
   OVERVIEW LIMIT
================================================== */

// Limit overview to 300 words.
function limitOverviewTo300Words(
    text
) {
    if (
        !text ||
        text === "Not specified"
    ) {
        return "Not specified";
    }

    const words =
        text.split(/\s+/);

    if (
        words.length <= 300
    ) {
        return text;
    }

    return (
        words
            .slice(
                0,
                300
            )
            .join(" ") +
        "..."
    );
}

/* ==================================================
   KEYWORD SEARCH
================================================== */

// Find all matching target keywords.
function findMatchingKeywords(
    job,
    details
) {
    const searchableText =
        [
            job.title,
            details.overview,
            details.skills,
        ]
            .map(
                normalizeMatchText
            )
            .join(" ");

    const matches = [];

    for (
        const keyword of TARGET_KEYWORDS
        ) {
        if (
            containsKeyword(
                searchableText,
                keyword
            )
        ) {
            matches.push(
                keyword
            );
        }
    }

    return [
        ...new Set(
            matches
        ),
    ];
}

// Check whether the job is relevant.
function isRelevantJob(
    job,
    details
) {
    const matchedKeywords =
        findMatchingKeywords(
            job,
            details
        );

    return {
        relevant:
            matchedKeywords.length >
            0,

        matchedKeywords,
    };
}

/* ==================================================
   DATE
================================================== */

// Format date for Telegram.
function formatDateTime(
    date
) {
    if (!date) {
        return "Unknown";
    }

    const parsed =
        new Date(date);

    if (
        Number.isNaN(
            parsed.getTime()
        )
    ) {
        return cleanText(
            String(date)
        );
    }

    return parsed
        .toLocaleString(
            "en-US",
            {
                year: "numeric",
                month: "short",
                day: "2-digit",
                hour: "numeric",
                minute: "2-digit",
                second: "2-digit",
                hour12: true,
            }
        )
        .replace(
            ",",
            ""
        );
}

/* ==================================================
   TELEGRAM MESSAGE
================================================== */

// Build the Telegram message.
function buildTelegramMessage(
    job,
    details
) {
    const overview =
        limitOverviewTo300Words(
            details.overview
        );

    return `${job.title}

Posted: ${formatDateTime(job.posted)}

JOB DETAILS
Type of Work: ${details.typeOfWork}
Wage / Salary: ${details.wage}
Hours per Week: ${details.hoursPerWeek}
Date Updated: ${details.dateUpdated}

JOB OVERVIEW
${overview}

SKILL REQUIREMENT
${details.skills}

${job.url}`;
}

/* ==================================================
   TELEGRAM
================================================== */

// Send one Telegram message.
async function sendTelegramMessage(
    message
) {
    if (
        !TELEGRAM_BOT_TOKEN ||
        !TELEGRAM_CHAT_ID
    ) {
        throw new Error(
            "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env"
        );
    }

    const url =
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    await axios.post(
        url,
        {
            chat_id:
            TELEGRAM_CHAT_ID,

            text:
            message,

            disable_web_page_preview:
                true,
        },
        {
            timeout: 30000,
        }
    );
}

// Split messages that are too long for Telegram.
async function sendLongTelegramMessage(
    message
) {
    const MAX_LENGTH =
        4000;

    if (
        message.length <=
        MAX_LENGTH
    ) {
        await sendTelegramMessage(
            message
        );

        return;
    }

    let remaining =
        message;

    while (
        remaining.length > 0
        ) {
        let chunk =
            remaining.slice(
                0,
                MAX_LENGTH
            );

        if (
            remaining.length >
            MAX_LENGTH
        ) {
            const lastNewLine =
                chunk.lastIndexOf(
                    "\n"
                );

            if (
                lastNewLine >
                1000
            ) {
                chunk =
                    chunk.slice(
                        0,
                        lastNewLine
                    );
            }
        }

        await sendTelegramMessage(
            chunk
        );

        remaining =
            remaining.slice(
                chunk.length
            );

        if (
            remaining.length > 0
        ) {
            await delay(1000);
        }
    }
}

/* ==================================================
   SEEN JOBS
================================================== */

// Load previously sent job IDs.
function loadSeenJobs() {
    try {
        if (
            !fs.existsSync(
                SEEN_JOBS_FILE
            )
        ) {
            return new Set();
        }

        const data =
            fs.readFileSync(
                SEEN_JOBS_FILE,
                "utf8"
            );

        const parsed =
            JSON.parse(data);

        if (
            !Array.isArray(
                parsed
            )
        ) {
            return new Set();
        }

        return new Set(
            parsed.map(String)
        );
    } catch (error) {
        console.error(
            "Failed to load seen-jobs.json:",
            error.message
        );

        return new Set();
    }
}

// Save sent job IDs.
function saveSeenJobs(
    seenJobs
) {
    fs.writeFileSync(
        SEEN_JOBS_FILE,
        JSON.stringify(
            [
                ...seenJobs,
            ],
            null,
            2
        ),
        "utf8"
    );
}

/* ==================================================
   MAIN
================================================== */

// Run the scraper.
async function main() {
    console.log(
        "Starting OnlineJobs.ph scraper..."
    );

    if (
        !TELEGRAM_BOT_TOKEN ||
        !TELEGRAM_CHAT_ID
    ) {
        throw new Error(
            "Telegram environment variables are missing."
        );
    }

    /* ----------------------------------------------
       SEARCH PAGE
    ---------------------------------------------- */

    console.log(
        "Downloading search page..."
    );

    const searchHtml =
        await getPage(
            SEARCH_URL
        );

    const jobs =
        extractJobs(
            searchHtml
        );

    console.log(
        `Found ${jobs.length} jobs on the search page.`
    );

    /* ----------------------------------------------
       SEEN JOBS
    ---------------------------------------------- */

    const seenJobs =
        loadSeenJobs();

    console.log(
        `Already seen: ${seenJobs.size}`
    );

    let checked = 0;
    let relevant = 0;
    let sent = 0;
    let skipped = 0;

    /* ----------------------------------------------
       PROCESS JOBS
    ---------------------------------------------- */

    for (
        const job of jobs
        ) {
        checked++;

        console.log(
            `\n[${checked}/${jobs.length}] ${job.title}`
        );

        /*
            Skip jobs already successfully
            delivered to Telegram.
        */
        if (
            seenJobs.has(
                String(job.id)
            )
        ) {
            console.log(
                "Already sent. Skipping."
            );

            skipped++;

            continue;
        }

        /*
            Wait before opening the
            individual job page.
        */
        await delay(
            REQUEST_DELAY
        );

        try {
            /* ------------------------------------------
               JOB PAGE
            ------------------------------------------ */

            const jobHtml =
                await getPage(
                    job.url
                );

            /* ------------------------------------------
               DETAILS
            ------------------------------------------ */

            const details =
                extractJobDetails(
                    jobHtml
                );

            /* ------------------------------------------
               POSTED DATE
            ------------------------------------------ */

            const visibleText =
                getVisiblePageText(
                    jobHtml
                );

            const postedMatch =
                visibleText.match(
                    /Posted(?:\s+on)?\s*:?\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}(?:\s*,?\s*\d{1,2}:\d{2}\s*(?:AM|PM))?)/i
                );

            if (
                postedMatch &&
                postedMatch[1]
            ) {
                job.posted =
                    postedMatch[1];
            } else {
                job.posted =
                    new Date();
            }

            /* ------------------------------------------
               MATCH KEYWORDS
            ------------------------------------------ */

            const result =
                isRelevantJob(
                    job,
                    details
                );

            if (
                !result.relevant
            ) {
                console.log(
                    "Not relevant."
                );

                continue;
            }

            relevant++;

            console.log(
                `Matches: ${result.matchedKeywords.join(
                    ", "
                )}`
            );

            /* ------------------------------------------
               TELEGRAM
            ------------------------------------------ */

            const message =
                buildTelegramMessage(
                    job,
                    details
                );

            await sendLongTelegramMessage(
                message
            );

            /*
                IMPORTANT:
                Only mark the job as seen
                AFTER Telegram succeeds.
            */
            seenJobs.add(
                String(job.id)
            );

            saveSeenJobs(
                seenJobs
            );

            sent++;

            console.log(
                "Sent to Telegram successfully."
            );
        } catch (error) {
            console.error(
                `Failed to process job ${job.id}:`,
                error.message
            );
        }
    }

    /* ----------------------------------------------
       SUMMARY
    ---------------------------------------------- */

    console.log(
        "\n--------------------------------"
    );

    console.log(
        "SCRAPER COMPLETE"
    );

    console.log(
        `Jobs checked: ${checked}`
    );

    console.log(
        `Relevant jobs: ${relevant}`
    );

    console.log(
        `Telegram sent: ${sent}`
    );

    console.log(
        `Skipped as already seen: ${skipped}`
    );

    console.log(
        "--------------------------------"
    );
}

/* ==================================================
   START
================================================== */

main().catch(
    (error) => {
        console.error(
            "\nFatal error:",
            error.message
        );

        process.exit(1);
    }
);