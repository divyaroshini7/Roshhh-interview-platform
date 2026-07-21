// This runs on the SERVER (Vercel), never in the user's browser.
// It's the only place that ever touches your Anthropic API key.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { system, userText } = req.body || {};
  if (!system || !userText) {
    return res.status(400).json({ error: "Missing system or userText" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY" });
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        // Check https://docs.claude.com for the current model ID before
        // deploying — model names are updated over time.
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 1000,
        system,
        messages: [{ role: "user", content: userText }],
      }),
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    console.error("Roshhh backend error:", err);
    return res.status(502).json({ error: "Failed to reach Anthropic API" });
  }
}
