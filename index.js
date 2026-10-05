require("dotenv").config();

const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

/* ==================================================
   CONFIGURATION
================================================== */

const BASE_URL = "https://www.onlinejobs.ph";

const SEARCH_URL =
    `${BASE_URL}/jobseekers/jobsearch`;

const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN;

const TELEGRAM_CHAT_ID =
    process.env.TELEGRAM_CHAT_ID;

const REQUEST_DELAY = 4000;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT = 30000;

const TELEGRAM_MAX_LENGTH = 4000;
const OVERVIEW_MAX_WORDS = 300;

const SEEN_JOBS_FILE =
    path.join(__dirname, "seen-jobs.json");

const SCANNED_JOBS_FILE =
    path.join(__dirname, "scanned-jobs.json");


const TARGET_KEYWORDS = [
    "next.js",
    "nextjs",
    "next js",
    "react",
    "react.js",
    "reactjs",
    "react js",
    "typescript",
    "javascript",
    "tailwind",
    "tailwindcss",
    "tailwind css",
    "three.js",
    "threejs",
    "three js",
    "gsap",
    "framer motion",
    "framer-motion",
    "front-end",
    "front end",
    "frontend developer",
    "front-end developer",
    "front end developer",
    "web developer",
    "web development",
    "website developer",
    "website development",
    "web designer",
    "website designer",
    "full stack",
    "full-stack",
    "fullstack",
    "supabase",
    "node.js",
    "nodejs",
    "node js",
    "3d website",
    "3d web developer",
    "3d web",
    "interactive website",
    "interactive web",
    "animated website",
    "animated web",
    "shadcn",
    "sanity",
    "dashboard developer",
];


/* ==================================================
   BASIC HELPERS
================================================== */

// Wait before making another request.
function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
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

// Normalize text before keyword matching.
function normalizeMatchText(text) {
    return (text || "")
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, "-")
        .replace(/[_/\\|]+/g, " ")
        .replace(/[^\w\s.-]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Escape RegExp characters.
function escapeRegex(text) {
    return String(text).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
    );
}

// Convert common technology separators into spaces.
function normalizeTechnologyText(text) {
    return normalizeMatchText(text)
        .replace(/\breact\s*js\b/g, "reactjs")
        .replace(/\bnext\s*js\b/g, "nextjs")
        .replace(/\bnode\s*js\b/g, "nodejs")
        .replace(/\bthree\s*js\b/g, "threejs")
        .replace(/\btype\s*script\b/g, "typescript")
        .replace(/\bjava\s*script\b/g, "javascript")
        .replace(/\btailwind\s*css\b/g, "tailwindcss")
        .replace(/\bfront\s*end\b/g, "frontend")
        .replace(/\bfull\s*stack\b/g, "fullstack")
        .replace(/\s+/g, " ")
        .trim();
}

/* ==================================================
   JOB TITLE
================================================== */

// Clean unwanted information from a job title.
function cleanJobTitle(title) {
    if (!title) {
        return "Untitled Job";
    }

    let cleaned = cleanText(title);

    cleaned = cleaned.replace(
        /\s+Posted on[\s\S]*$/i,
        ""
    );

    cleaned = cleaned.replace(
        /\s+(Full Time|Part Time|Any Type|Any)\s*$/i,
        ""
    );

    cleaned = cleaned.replace(
        /\s+\bTBD\b\s*$/i,
        ""
    );

    cleaned = cleaned.replace(
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

/*
 * Match a keyword as a complete phrase.
 *
 * The normalized text is checked instead of raw text,
 * which handles React.js / ReactJS / React JS consistently.
 */
function containsKeyword(text, keyword) {
    const normalizedText =
        normalizeTechnologyText(text);

    const normalizedKeyword =
        normalizeTechnologyText(keyword);

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

    return regex.test(normalizedText);
}

/*
 * Find all keyword matches.
 */
function findKeywordMatches(text, keywords) {
    const matches = [];

    for (const keyword of keywords) {
        if (
            containsKeyword(
                text,
                keyword
            )
        ) {
            matches.push(keyword);
        }
    }

    return [
        ...new Set(matches),
    ];
}

/* ==================================================
   HTTP REQUEST
================================================== */

/*
 * Download a page with controlled retry support.
 *
 * Permanent 4xx errors such as 404 and 410 are not retried.
 */
async function getPage(url) {
    let lastError = null;

    for (
        let attempt = 1;
        attempt <= MAX_RETRIES;
        attempt++
    ) {
        try {
            const response =
                await axios.get(
                    url,
                    {
                        timeout:
                        REQUEST_TIMEOUT,

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

                        validateStatus:
                            (status) =>
                                status >= 200 &&
                                status < 300,
                    }
                );

            return response.data;
        } catch (error) {
            lastError = error;

            const status =
                error.response?.status;

            const retryAfter =
                error.response?.headers?.[
                    "retry-after"
                    ];

            /*
             * Rate limited.
             */
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
                    `Rate limited. Waiting ${Math.ceil(
                        waitTime / 1000
                    )} seconds...`
                );

                await delay(
                    waitTime
                );

                continue;
            }

            /*
             * Server error.
             */
            if (
                status >= 500 &&
                status <= 599
            ) {
                if (
                    attempt >=
                    MAX_RETRIES
                ) {
                    break;
                }

                console.log(
                    `Server error ${status}. Retrying ${attempt}/${MAX_RETRIES}...`
                );

                await delay(
                    5000 * attempt
                );

                continue;
            }

            /*
             * Temporary network error.
             */
            if (
                error.code ===
                "ECONNRESET" ||
                error.code ===
                "ETIMEDOUT" ||
                error.code ===
                "ECONNABORTED"
            ) {
                if (
                    attempt >=
                    MAX_RETRIES
                ) {
                    break;
                }

                console.log(
                    `Network error. Retrying ${attempt}/${MAX_RETRIES}...`
                );

                await delay(
                    5000 * attempt
                );

                continue;
            }

            /*
             * Permanent HTTP errors such as 404 / 410
             * are immediately returned to the caller.
             */
            if (
                status >= 400 &&
                status <= 499
            ) {
                throw error;
            }

            /*
             * Unknown error.
             */
            throw error;
        }
    }

    throw lastError;
}

/* ==================================================
   SEARCH PAGE
================================================== */

/*
 * Extract the exact posted date from a search-page job card.
 */
function extractPostedDateFromCard(
    cardText
) {
    if (!cardText) {
        return null;
    }

    const match =
        cardText.match(
            /Posted\s+on\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/i
        );

    if (
        match &&
        match[1]
    ) {
        return cleanText(
            match[1]
        );
    }

    return null;
}

/*
 * Extract jobs from the search page.
 */
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
                    : `${BASE_URL}${href}`;

            /*
             * The last number in the URL is the job ID.
             */
            const idMatches =
                url.match(/\d+/g);

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
             * Avoid duplicate job IDs.
             */
            if (
                seenIds.has(id)
            ) {
                return;
            }

            /*
             * Extract the exact posted timestamp
             * directly from the search-page card.
             */
            const cardText =
                cleanText(
                    card.text()
                );

            const postedDate =
                extractPostedDateFromCard(
                    cardText
                );

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
                title ===
                "Untitled Job"
            ) {
                return;
            }

            seenIds.add(id);

            jobs.push({
                id,
                title,
                url,
                posted:
                    postedDate ||
                    "Unknown",
            });
        }
    );

    return jobs;
}

/* ==================================================
   DETAIL PAGE TEXT
================================================== */

/*
 * Prepare visible text from a job page.
 */
function getVisiblePageText(html) {
    const $ =
        cheerio.load(html);

    /*
     * Remove elements that should not be scanned.
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

/*
 * Remove common footer/navigation garbage.
 */
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

/*
 * Extract a section from visible text.
 */
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
            .replace(
                /\u00a0/g,
                " "
            )
            .replace(
                /\r/g,
                ""
            )
            .replace(
                /\n/g,
                " "
            )
            .replace(
                /\s+/g,
                " "
            )
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

/*
 * Find a heading-like element containing the label.
 */
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

/*
 * Extract section content from the DOM.
 */
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
     * First try following siblings.
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
     * Try the parent container.
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
         * Remove the section label itself.
         */
        clone
            .find("*")
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

/*
 * Extract overview, skills and metadata.
 */
function extractJobDetails(html) {
    const $ =
        cheerio.load(html);

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
     * Search common visible elements.
     */
    $(
        "li, p, td, th, dt, dd, div"
    ).each(function () {
        const element =
            $(this);

        /*
         * Ignore large parent containers.
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

/*
 * Limit overview to 300 words.
 */
function limitOverviewTo300Words(text) {
    if (
        !text ||
        text ===
        "Not specified"
    ) {
        return "Not specified";
    }

    const words =
        text.split(/\s+/);

    if (
        words.length <=
        OVERVIEW_MAX_WORDS
    ) {
        return text;
    }

    return (
        words
            .slice(
                0,
                OVERVIEW_MAX_WORDS
            )
            .join(" ") +
        "..."
    );
}

/* ==================================================
   RELEVANCE
================================================== */

/*
 * Find all matching target keywords.
 */
function findMatchingKeywords(
    job,
    details
) {
    const titleText =
        normalizeTechnologyText(
            job.title
        );

    const overviewText =
        normalizeTechnologyText(
            details.overview
        );

    const skillsText =
        normalizeTechnologyText(
            details.skills
        );

    const fullText =
        [
            titleText,
            overviewText,
            skillsText,
        ]
            .filter(Boolean)
            .join(" ");

    const matches =
        findKeywordMatches(
            fullText,
            TARGET_KEYWORDS
        );

    /*
     * Remove duplicate variants that refer
     * to the same technology.
     */
    const canonicalGroups = [
        [
            "next.js",
            "nextjs",
            "next js",
        ],
        [
            "react",
            "react.js",
            "reactjs",
            "react js",
        ],
        [
            "typescript",
            "type script",
        ],
        [
            "javascript",
            "java script",
        ],
        [
            "tailwind",
            "tailwindcss",
        ],
        [
            "three.js",
            "threejs",
            "three js",
        ],
        [
            "node.js",
            "nodejs",
            "node js",
        ],
        [
            "frontend",
            "front-end",
            "front end",
        ],
        [
            "full stack",
            "full-stack",
            "fullstack",
        ],
    ];

    const finalMatches = [];
    const normalizedMatches =
        new Set(
            matches.map(
                normalizeTechnologyText
            )
        );

    for (
        const group of canonicalGroups
        ) {
        const found =
            group.some(
                (keyword) =>
                    normalizedMatches.has(
                        normalizeTechnologyText(
                            keyword
                        )
                    )
            );

        if (found) {
            finalMatches.push(
                group[0]
            );
        }
    }

    for (
        const match of matches
        ) {
        const belongsToGroup =
            canonicalGroups.some(
                (group) =>
                    group.some(
                        (keyword) =>
                            normalizeTechnologyText(
                                keyword
                            ) ===
                            normalizeTechnologyText(
                                match
                            )
                    )
            );

        if (!belongsToGroup) {
            finalMatches.push(
                match
            );
        }
    }

    return [
        ...new Set(
            finalMatches
        ),
    ];
}

/*
 * Determine whether a job is relevant.
 */
function isRelevantJob(
    job,
    details
) {
    const matchedKeywords =
        findMatchingKeywords(
            job,
            details
        );

    /*
     * A job is relevant if at least one target
     * keyword appears in title, overview or skills.
     */
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

/*
 * Format the exact OnlineJobs.ph posted date.
 *
 * The date is treated as plain text so GitHub Actions
 * cannot convert it through its UTC timezone.
 */
function formatDateTime(
    date
) {
    if (!date) {
        return "Unknown";
    }

    const value =
        cleanText(
            String(date)
        );

    /*
     * Format:
     * 2026-09-29 23:12:36
     *
     * Result:
     * Tue Sep 29 2026, 11:12:36 PM
     */
    const numericMatch =
        value.match(
            /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/
        );

    if (numericMatch) {
        const [
            ,
            year,
            month,
            day,
            hour,
            minute,
            second,
        ] = numericMatch;

        const dateParts =
            new Date(
                Number(year),
                Number(month) - 1,
                Number(day)
            );

        const weekdayNames = [
            "Sun",
            "Mon",
            "Tue",
            "Wed",
            "Thu",
            "Fri",
            "Sat",
        ];

        const monthNames = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
        ];

        const hourNumber =
            Number(hour);

        const displayHour =
            hourNumber === 0
                ? 12
                : hourNumber > 12
                    ? hourNumber - 12
                    : hourNumber;

        const period =
            hourNumber >= 12
                ? "PM"
                : "AM";

        return (
            `${weekdayNames[dateParts.getDay()]} ` +
            `${monthNames[Number(month) - 1]} ` +
            `${day} ${year}, ` +
            `${displayHour}:${minute}:${second} ${period}`
        );
    }

    /*
     * Format JavaScript-style date strings without
     * converting the timezone.
     *
     * Example:
     * Wed Sep 30 2026 00:51:51 GMT+0800
     *
     * Result:
     * Wed Sep 30 2026, 12:51:51 AM
     */
    const browserDateMatch =
        value.match(
            /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/
        );

    if (browserDateMatch) {
        const [
            ,
            weekday,
            month,
            day,
            year,
            hour,
            minute,
            second,
        ] = browserDateMatch;

        const hourNumber =
            Number(hour);

        const displayHour =
            hourNumber === 0
                ? 12
                : hourNumber > 12
                    ? hourNumber - 12
                    : hourNumber;

        const period =
            hourNumber >= 12
                ? "PM"
                : "AM";

        return (
            `${weekday} ${month} ${day} ${year}, ` +
            `${displayHour}:${minute}:${second} ${period}`
        );
    }

    return value;
}

/* ==================================================
   TELEGRAM MESSAGE
================================================== */

/*
 * Build the Telegram message.
 */
function buildTelegramMessage(
    job,
    details
) {
    const overview =
        limitOverviewTo300Words(
            details.overview
        );

    return `JOB POST 😎.
    
${job.title}
    
Posted: ${formatDateTime(job.posted)}

JOB DETAILS
Type of Work: ${details.typeOfWork}
Wage / Salary: ${details.wage}
Hours per Week: ${details.hoursPerWeek}
Date Updated: ${details.dateUpdated}

JOB OVERVIEW
${overview}

SKILL REQUIREMENT
${details.skills.join("\n")}

${job.url}`;
}

/* ==================================================
   TELEGRAM
================================================== */

/*
 * Send one Telegram message.
 */
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
            timeout:
            REQUEST_TIMEOUT,
        }
    );
}

/*
 * Split messages that are too long for Telegram.
 */
async function sendLongTelegramMessage(
    message
) {
    if (
        message.length <=
        TELEGRAM_MAX_LENGTH
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
                TELEGRAM_MAX_LENGTH
            );

        if (
            remaining.length >
            TELEGRAM_MAX_LENGTH
        ) {
            const lastNewLine =
                chunk.lastIndexOf(
                    "\n"
                );

            if (
                lastNewLine > 1000
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
            await delay(
                1000
            );
        }
    }
}

/* ==================================================
   SEEN JOBS
================================================== */

/*
 * Load previously sent job IDs.
 */
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

/*
 * Save sent job IDs.
 */
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
   SCANNED JOBS
================================================== */

/*
 * Load job IDs that have already been scanned.
 */
function loadScannedJobs() {
    try {
        if (
            !fs.existsSync(
                SCANNED_JOBS_FILE
            )
        ) {
            return new Set();
        }

        const data =
            fs.readFileSync(
                SCANNED_JOBS_FILE,
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
            "Failed to load scanned-jobs.json:",
            error.message
        );

        return new Set();
    }
}

/*
 * Save scanned job IDs.
 */
function saveScannedJobs(
    scannedJobs
) {
    fs.writeFileSync(
        SCANNED_JOBS_FILE,
        JSON.stringify(
            [
                ...scannedJobs,
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

/*
 * Run the scraper.
 */
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
        `Already sent: ${seenJobs.size}`
    );

    /* ----------------------------------------------
       SCANNED JOBS
    ---------------------------------------------- */

    const scannedJobs =
        loadScannedJobs();

    console.log(
        `Already scanned: ${scannedJobs.size}`
    );

    let checked = 0;
    let newJobs = 0;
    let relevant = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;

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

        /* ------------------------------------------
           SKIP ALREADY SCANNED JOB
        ------------------------------------------ */

        if (
            scannedJobs.has(
                String(job.id)
            )
        ) {
            console.log(
                `Already scanned. Skipping API call. Job ID: ${job.id}`
            );

            skipped++;

            continue;
        }

        newJobs++;

        console.log(
            `New job detected. Job ID: ${job.id}`
        );

        /*
         * Wait before opening the individual
         * job page to avoid rapid requests.
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
            } else {
                relevant++;

                console.log(
                    `Matches: ${result.matchedKeywords.join(
                        ", "
                    )}`
                );

                /* --------------------------------------
                   TELEGRAM
                -------------------------------------- */

                /*
                 * Never mark a job as seen before
                 * Telegram successfully accepts it.
                 */
                const message =
                    buildTelegramMessage(
                        job,
                        details
                    );

                await sendLongTelegramMessage(
                    message
                );

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
            }

            /* ------------------------------------------
               MARK AS SCANNED
            ------------------------------------------ */

            /*
             * Only successfully processed jobs
             * are saved as scanned.
             */
            scannedJobs.add(
                String(job.id)
            );

            saveScannedJobs(
                scannedJobs
            );

            console.log(
                "Job marked as scanned."
            );
        } catch (error) {
            failed++;

            const status =
                error.response?.status;

            if (status) {
                console.error(
                    `Failed to process job ${job.id}: HTTP ${status} - ${error.message}`
                );
            } else {
                console.error(
                    `Failed to process job ${job.id}: ${error.message}`
                );
            }

            /*
             * IMPORTANT:
             * Failed jobs are intentionally NOT added
             * to scanned-jobs.json.
             *
             * They can be retried on the next scan.
             */
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
        `Jobs found: ${jobs.length}`
    );

    console.log(
        `Jobs checked: ${checked}`
    );

    console.log(
        `New jobs scanned: ${newJobs}`
    );

    console.log(
        `Already scanned: ${skipped}`
    );

    console.log(
        `Relevant jobs: ${relevant}`
    );

    console.log(
        `Telegram sent: ${sent}`
    );

    console.log(
        `Failed jobs: ${failed}`
    );

    console.log(
        `Total scanned jobs saved: ${scannedJobs.size}`
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
