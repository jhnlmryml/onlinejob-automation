const axios = require("axios");
require("dotenv").config();

async function test() {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;

    console.log("Token loaded:", Boolean(token));
    console.log("Chat ID:", chatId);

    const url = `https://api.telegram.org/bot${token}/sendMessage`;

    try {
        const response = await axios.post(url, {
            chat_id: chatId,
            text: "OnlineJobs notifier is working!",
        });

        console.log(response.data);
    } catch (error) {
        console.log("Telegram response:");
        console.log(error.response?.data || error.message);
    }
}

test();