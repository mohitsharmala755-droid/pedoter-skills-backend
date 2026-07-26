// backend/routes/files.js
// Upload + skill-processing endpoints, gated by plan.

const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');
const { requirePlan, enforceUploadLimits } = require('../middleware/planAccess');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const BUCKET = 'documents';

// ---- Upload (all plans, limits enforced by middleware) ----
router.post('/upload', requireAuth, enforceUploadLimits, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const path = `${req.user.id}/${uuid()}-${req.file.originalname}`;
    const { error: uploadErr } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(path, req.file.buffer, { contentType: req.file.mimetype });
    if (uploadErr) throw uploadErr;

    const { data: row, error: dbErr } = await supabaseAdmin
      .from('files')
      .insert({
        user_id: req.user.id,
        storage_path: path,
        original_name: req.file.originalname,
        size_bytes: req.file.size,
        mime_type: req.file.mimetype,
        status: 'uploaded',
        watermarked: req.planLimits?.watermark ?? true,
      })
      .select()
      .single();
    if (dbErr) throw dbErr;

    res.json({ file: row });
  } catch (err) {
    next(err);
  }
});

// ---- Free + paid tools ----
router.post('/:fileId/ocr', requireAuth, async (req, res, next) => {
  // Enqueue OCR job (e.g. push to a queue / call a worker service).
  res.json({ queued: true, skill: 'ocr' });
});

router.post('/:fileId/edit', requireAuth, requirePlan('starter'), async (req, res, next) => {
  res.json({ queued: true, skill: 'edit' });
});

router.post('/:fileId/translate', requireAuth, requirePlan('starter'), async (req, res, next) => {
  res.json({ queued: true, skill: 'translate' });
});

router.post('/:fileId/image-to-pdf', requireAuth, requirePlan('starter'), async (req, res, next) => {
  res.json({ queued: true, skill: 'image_to_pdf' });
});

router.post('/:fileId/pdf-to-excel', requireAuth, requirePlan('starter'), async (req, res, next) => {
  res.json({ queued: true, skill: 'pdf_to_excel' });
});

// ---- Pro-only AI tools ----
router.post('/:fileId/summary', requireAuth, requirePlan('pro'), async (req, res, next) => {
  res.json({ queued: true, skill: 'ai_summary' });
});

router.post('/:fileId/chat', requireAuth, requirePlan('pro'), async (req, res, next) => {
  res.json({ queued: true, skill: 'chat_with_pdf' });
});

router.post('/:fileId/rewrite', requireAuth, requirePlan('pro'), async (req, res, next) => {
  res.json({ queued: true, skill: 'ai_rewrite' });
});

router.post('/:fileId/notes', requireAuth, requirePlan('pro'), async (req, res, next) => {
  res.json({ queued: true, skill: 'ai_notes' });
});

module.exports = router;
