const express = require("express");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
app.use(express.json());

const PUMBLE_WEBHOOK_URL = "https://api.pumble.com/workspaces/68b1f7f5676885957db941cc/incomingWebhooks/postMessage/PZEvXCCeejbZPCgDWQmmmxQv";
const CLICKUP_WEBHOOK_SECRET = "G6WHRPT5D7PC7JNGUQ5E8EDZEMNEGUJSVKIKOK9T478VRAVNTGPO9W8DO07XUJD1";
const CLICKUP_API_KEY = "pk_236544229_05XOSBKVYW1TIJ4LE63SZCIUTGPAX6BV";
const PUMBLE_API_KEY = "90b0353b8b908663b2efddfe9cd596bb";

const SKIP_SIGNATURE = false;

// Cache so we don't look up the same email twice
const userIdCache = {};

function verifySignature(req) {
    const signature = req.headers["x-signature"];
    if (!signature) return false;
    const hash = crypto
        .createHmac("sha256", CLICKUP_WEBHOOK_SECRET)
        .update(JSON.stringify(req.body))
        .digest("hex");
    return hash === signature;
}

async function getTaskDetails(taskId) {
    const res = await axios.get(`https://api.clickup.com/api/v2/task/${taskId}`, {
        headers: { Authorization: CLICKUP_API_KEY },
    });
    return res.data;
}

async function getPumbleUserId(email) {
    if (userIdCache[email]) return userIdCache[email];

    try {
        const res = await axios.get(
            "https://pumble-api-keys.addons.marketplace.cake.com/listUsers",
            { headers: { "Api-Key": PUMBLE_API_KEY } }
        );

        const users = res.data || [];
        const match = users.find(u => u.email === email);

        if (match) {
            userIdCache[email] = match.id;
            return match.id;
        }
    } catch (err) {
        console.error("Failed to fetch Pumble users:", err.message);
    }

    return null;
}

async function buildMessage(task, assignee) {
    const description = task.description
        ? task.description.trim().slice(0, 150) + (task.description.length > 150 ? "..." : "")
        : null;

    const pumbleUserId = await getPumbleUserId(assignee.email);
    const mention = pumbleUserId ? `<<@${pumbleUserId}>>` : assignee.username;

    const lines = [
        `${mention} you have been assigned a new task.`,
        ``,
        `*Task:* ${task.name}`,
        description ? `*Description:* ${description}` : null,
        `*Status:* ${task.status.status}`,
        `*Priority:* ${task.priority?.priority || "None"}`,
        `*Link:* ${task.url}`,
    ];

    return { text: lines.filter(line => line !== null).join("\n") };
}
app.post("/webhook", async (req, res) => {
    if (!SKIP_SIGNATURE && !verifySignature(req)) {
        console.log("Invalid signature, ignoring request");
        return res.status(401).send("Unauthorized");
    }

    const { event, task_id, history_items } = req.body;

    if (event !== "taskAssigneeUpdated") {
        return res.status(200).send("Ignored");
    }

    try {
        const task = await getTaskDetails(task_id);

        // Only notify on assignee_add, ignore assignee_rem
        const addedAssignees = [];
        if (history_items && history_items.length > 0) {
            for (const item of history_items) {
                if (item.field === "assignee_add" && item.after) {
                    addedAssignees.push(item.after);
                }
            }
        }

        if (addedAssignees.length === 0) {
            console.log("No new assignees, skipping");
            return res.status(200).send("No new assignees");
        }

        for (const assignee of addedAssignees) {
            const message = await buildMessage(task, assignee);
            await axios.post(PUMBLE_WEBHOOK_URL, message);
            console.log(`Notified Pumble for: ${assignee.email}`);
        }

        res.status(200).send("OK");
    } catch (err) {
        console.error("Error:", err.message);
        res.status(500).send("Error");
    }
});

app.get("/", (req, res) => res.send("ClickUp-Pumble bot is running!"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));