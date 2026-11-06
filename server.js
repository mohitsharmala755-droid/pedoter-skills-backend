// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const razorpayRoutes = require('./routes/razorpay');
const filesRoutes = require('./routes/files');
const earnhubRoutes = require('./routes/earnhub');
const resumeRoutes = require('./routes/resume');

const app = express();

app.use(helmet());
app.set('trust proxy', 1);
app.use(cors({ origin: process.env.FRONTEND_URL, credentials: true }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));

// IMPORTANT: the Razorpay webhook needs the raw body for signature verification,
// so it must be mounted BEFORE express.json().
app.use('/api/razorpay/webhook', express.raw({ type: 'application/json' }));
app.use('/api/razorpay/webhook', razorpayRoutes);

app.use(express.json());

app.use('/api/razorpay', razorpayRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/earnhub', earnhubRoutes);
app.use('/api/resume', resumeRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Pedoter Skills API running on port ${PORT}`));
