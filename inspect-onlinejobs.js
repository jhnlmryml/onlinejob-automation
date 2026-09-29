const axios = require("axios");
const fs = require("fs");

const URL = "https://www.onlinejobs.ph/jobseekers/jobsearch";

async function inspect() {
    const response = await axios.get(URL, {
        headers: {
            "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
            Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    });

    fs.writeFileSync("onlinejobs.html", response.data);

    console.log("HTML saved to onlinejobs.html");
    console.log("HTML length:", response.data.length);
}

inspect().catch((error) => {
    console.error(error.response?.status || error.message);
});