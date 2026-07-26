// backend/middleware/planAccess.js
// Loads the caller's active plan and enforces per-plan limits
// (daily upload count, file size, watermarking, feature gating).

const { supabaseAdmin } = require('../config/supabase');

const PLAN_RANK = { free: 0, starter: 1, pro: 2 };

async function getActivePlan(userId) {
  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('plan_id, status, current_end')
    .eq('user_id', userId)
    .in('status', ['active', 'authenticated'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sub && (!sub.current_end || new Date(sub.current_end) > new Date())) {
    return sub.plan_id;
  }
  return 'free';
}

// requirePlan('starter') -> allows starter or pro, blocks free
function requirePlan(minPlan) {
  return async (req, res, next) => {
    try {
      const planId = await getActivePlan(req.user.id);
      req.planId = planId;

      if (PLAN_RANK[planId] < PLAN_RANK[minPlan]) {
        return res.status(403).json({
          error: `This feature needs the ${minPlan} plan or higher`,
          currentPlan: planId,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Enforces Free plan's daily upload cap + max file size. No-op for paid plans.
async function enforceUploadLimits(req, res, next) {
  try {
    const planId = req.planId || (await getActivePlan(req.user.id));
    const { data: plan } = await supabaseAdmin
      .from('plans')
      .select('max_uploads_per_day, max_file_size_mb, watermark')
      .eq('id', planId)
      .single();

    req.planLimits = plan;

    if (plan.max_file_size_mb) {
      const sizeMb = Number(req.headers['x-file-size-mb'] || 0);
      if (sizeMb > plan.max_file_size_mb) {
        return res.status(413).json({ error: `File exceeds the ${plan.max_file_size_mb} MB limit on your plan` });
      }
    }

    if (plan.max_uploads_per_day) {
      const today = new Date().toISOString().slice(0, 10);
      const { data: usage } = await supabaseAdmin
        .from('usage_daily')
        .select('uploads_count')
        .eq('user_id', req.user.id)
        .eq('usage_date', today)
        .maybeSingle();

      const count = usage?.uploads_count || 0;
      if (count >= plan.max_uploads_per_day) {
        return res.status(429).json({ error: `Daily upload limit (${plan.max_uploads_per_day}) reached on the Free plan` });
      }

      await supabaseAdmin
        .from('usage_daily')
        .upsert({ user_id: req.user.id, usage_date: today, uploads_count: count + 1 }, { onConflict: 'user_id,usage_date' });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requirePlan, enforceUploadLimits, getActivePlan };
