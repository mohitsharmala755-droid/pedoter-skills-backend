// backend/routes/earnhub.js
// Earn Hub — AI career/skill advisor. Given a target salary, country, and the
// skills a user already has, asks Gemini for a prioritized roadmap of what to
// learn next, with free resources to learn each one.
//
// Phase 1 (this file): uses Gemini's own knowledge, no live web search.
// Phase 2 (future): add Google Search grounding for more current, localized results.

const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const GEMINI_MODEL = 'gemini-3.6-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

function buildPrompt({ targetSalary, currency, country, currentSkills }) {
  const skillsLine = currentSkills && currentSkills.trim()
    ? `The user already knows: ${currentSkills.trim()}. Do not repeat these — build on them instead.`
    : 'The user has no listed skills yet — start from the basics.';

  return `You are a practical, honest career advisor helping someone figure out what skills to learn to realistically earn ${currency}${targetSalary}/month in ${country}.

${skillsLine}

Give a prioritized roadmap of 4-8 skills they need to learn, ordered by impact (most important first). For each skill:
- A short "why this matters" explanation (1 sentence)
- 1-2 free resources to learn it (real, well-known resources like specific YouTube channels, freeCodeCamp, Coursera free courses, official docs — not made-up links)

Be realistic and honest — do not promise a guaranteed job or exaggerate. Base this on what employers actually look for at this salary level in ${country}.

Respond ONLY with valid JSON in exactly this shape, no other text:
{
  "summary": "one or two sentence overview of what this salary bracket typically requires",
  "skills": [
    { "name": "Skill name", "why": "why it matters", "resources": ["Resource 1", "Resource 2"] }
  ]
}`;
}

router.post('/roadmap', requireAuth, async (req, res, next) => {
  try {
    const { targetSalary, currency, country, currentSkills } = req.body;

    if (!targetSalary || !country) {
      return res.status(400).json({ error: 'targetSalary and country are required' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'Earn Hub is not configured yet (missing GEMINI_API_KEY)' });
    }

    const prompt = buildPrompt({
      targetSalary,
      currency: currency || '₹',
      country,
      currentSkills,
    });

    const geminiRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error('Gemini API error:', errText);
      return res.status(502).json({ error: 'Could not generate a roadmap right now — try again in a moment' });
    }

    const data = await geminiRes.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return res.status(502).json({ error: 'Got an empty response — try again' });
    }

    let roadmap;
    try {
      roadmap = JSON.parse(rawText);
    } catch (e) {
      return res.status(502).json({ error: 'Could not parse the roadmap — try again' });
    }

    res.json({ roadmap, targetSalary, currency: currency || '₹', country });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
