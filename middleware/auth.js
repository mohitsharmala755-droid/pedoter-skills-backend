// backend/middleware/auth.js
// Verifies the Supabase access token sent by the frontend as:
//   Authorization: Bearer <access_token>

const { supabaseAdmin } = require('../config/supabase');

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ error: 'Missing access token' });
    }

    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    req.user = data.user; // { id, email, ... }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth };
