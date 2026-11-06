// backend/routes/resume.js
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function buildSummaryPrompt({ jobTitle, yearsExperience, draft }) {
  return `Write a professional resume summary (2-3 sentences, no more) for a ${jobTitle || 'professional'}${yearsExperience ? ` with ${yearsExperience} years of experience` : ''}.

${draft ? `Their rough draft to improve: "${draft}"` : 'They have not written a draft — write one from scratch based on the role.'}

Rules:
- ATS-friendly: plain sentences, no special characters
- Confident but not exaggerated
- No first-person pronouns ("I", "my")
- Output ONLY the summary text, nothing else`;
}

function buildBulletsPrompt({ jobTitle, company, draft }) {
  return `Rewrite these rough work notes into 2-4 strong resume bullet points for a ${jobTitle || 'role'}${company ? ` at ${company}` : ''}.

Rough notes: "${draft}"

Rules:
- Start each bullet with a strong action verb
- Quantify impact only where the notes give a basis — never invent numbers
- Plain text, no special characters
- One bullet per line, no bullet symbol
- Output ONLY the bullet lines, nothing else`;
}

router.post('/improve', requireAuth, async (req, res, next) => {
  try {
    const { type, jobTitle, company, yearsExperience, draft } = req.body;
    if (!type || !['summary', 'bullets'].includes(type)) {
      return res.status(400).json({ error: 'type must be "summary" or "bullets"' });
    }
    if (type === 'bullets' && (!draft || !draft.trim())) {
      return res.status(400).json({ error: 'Add at least a rough note before improving bullet points' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'AI assist is not configured yet (missing GEMINI_API_KEY)' });
    }

    const prompt = type === 'summary'
      ? buildSummaryPrompt({ jobTitle, yearsExperience, draft })
      : buildBulletsPrompt({ jobTitle, company, draft });

    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.5 },
      }),
    });

    if (!geminiRes.ok) {
      console.error('Gemini API error (resume):', await geminiRes.text());
      return res.status(502).json({ error: 'Could not generate that right now — try again in a moment' });
    }

    const data = await geminiRes.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return res.status(502).json({ error: 'Got an empty response — try again' });
    }

    res.json({ result: text.trim() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
