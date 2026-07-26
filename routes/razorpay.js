// backend/routes/razorpay.js
// Production Razorpay Subscriptions integration.
//
// Flow:
//  1. POST /api/razorpay/create-subscription  -> frontend opens Razorpay Checkout
//  2. Checkout success -> POST /api/razorpay/verify -> confirms signature, activates plan
//  3. Razorpay server -> POST /api/razorpay/webhook -> source of truth for renewals,
//     failures, cancellations (works even if the user closes the browser tab)

const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { supabaseAdmin } = require('../config/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// ----------------------------------------------------------------
// 1. Create a subscription (called from the pricing page)
// body: { planId: 'starter' | 'pro' }
// ----------------------------------------------------------------
router.post('/create-subscription', requireAuth, async (req, res, next) => {
  try {
    const { planId } = req.body;
    if (!['starter', 'pro'].includes(planId)) {
      return res.status(400).json({ error: 'Invalid planId' });
    }

    const { data: plan, error: planErr } = await supabaseAdmin
      .from('plans')
      .select('*')
      .eq('id', planId)
      .single();
    if (planErr || !plan?.razorpay_plan_id) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Razorpay subscription — total_count = 120 (10 years of monthly cycles),
    // acts as a rolling auto-pay subscription until the user cancels.
    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.razorpay_plan_id,
      customer_notify: 1,
      total_count: 120,
      notes: { user_id: req.user.id, plan_id: planId },
    });

    // Store as 'created' — webhook / verify step will flip it to 'active'
    await supabaseAdmin.from('subscriptions').insert({
      user_id: req.user.id,
      plan_id: planId,
      razorpay_subscription_id: subscription.id,
      status: 'created',
    });

    res.json({
      subscriptionId: subscription.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
      planName: plan.name,
      amount: plan.price_inr,
    });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------
// 2. Verify checkout response (called immediately after Razorpay Checkout succeeds)
// body: { razorpay_payment_id, razorpay_subscription_id, razorpay_signature }
// ----------------------------------------------------------------
router.post('/verify', requireAuth, async (req, res, next) => {
  try {
    const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature } = req.body;

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_payment_id}|${razorpay_subscription_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment signature verification failed' });
    }

    await supabaseAdmin
      .from('subscriptions')
      .update({ status: 'authenticated', updated_at: new Date().toISOString() })
      .eq('razorpay_subscription_id', razorpay_subscription_id)
      .eq('user_id', req.user.id);

    res.json({ verified: true });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------
// 3. Webhook — Razorpay -> server. This is the source of truth.
// IMPORTANT: mount this route with `express.raw({ type: 'application/json' })`
// in server.js BEFORE the global express.json() body parser, since the
// signature is computed over the raw request body.
// ----------------------------------------------------------------
router.post('/webhook', async (req, res, next) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.body) // raw buffer
      .digest('hex');

    if (signature !== expected) {
      return res.status(400).send('Invalid webhook signature');
    }

    const event = JSON.parse(req.body.toString());
    const entity = event.payload?.subscription?.entity;
    const paymentEntity = event.payload?.payment?.entity;

    switch (event.event) {
      case 'subscription.activated':
      case 'subscription.charged': {
        await supabaseAdmin
          .from('subscriptions')
          .update({
            status: 'active',
            current_start: entity?.current_start ? new Date(entity.current_start * 1000) : null,
            current_end: entity?.current_end ? new Date(entity.current_end * 1000) : null,
            updated_at: new Date().toISOString(),
          })
          .eq('razorpay_subscription_id', entity.id);

        if (paymentEntity) {
          const { data: subRow } = await supabaseAdmin
            .from('subscriptions')
            .select('id, user_id')
            .eq('razorpay_subscription_id', entity.id)
            .maybeSingle();

          await supabaseAdmin.from('payments').insert({
            user_id: subRow?.user_id,
            subscription_id: subRow?.id,
            razorpay_payment_id: paymentEntity.id,
            amount_inr: paymentEntity.amount / 100,
            status: paymentEntity.status,
            raw_event: event,
          });
        }
        break;
      }

      case 'subscription.pending':
        await supabaseAdmin
          .from('subscriptions')
          .update({ status: 'pending', updated_at: new Date().toISOString() })
          .eq('razorpay_subscription_id', entity.id);
        break;

      case 'subscription.halted':
        await supabaseAdmin
          .from('subscriptions')
          .update({ status: 'halted', updated_at: new Date().toISOString() })
          .eq('razorpay_subscription_id', entity.id);
        break;

      case 'subscription.cancelled':
      case 'subscription.completed':
        await supabaseAdmin
          .from('subscriptions')
          .update({ status: event.event === 'subscription.cancelled' ? 'cancelled' : 'completed', updated_at: new Date().toISOString() })
          .eq('razorpay_subscription_id', entity.id);
        break;

      default:
        // Ignore events we don't act on, but 200 so Razorpay doesn't retry forever.
        break;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------------------
// 4. Cancel subscription (user-initiated, from the dashboard)
// ----------------------------------------------------------------
router.post('/cancel', requireAuth, async (req, res, next) => {
  try {
    const { data: sub } = await supabaseAdmin
      .from('subscriptions')
      .select('razorpay_subscription_id')
      .eq('user_id', req.user.id)
      .in('status', ['active', 'authenticated'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sub) return res.status(404).json({ error: 'No active subscription found' });

    await razorpay.subscriptions.cancel(sub.razorpay_subscription_id, { cancel_at_cycle_end: 0 });
    res.json({ cancelled: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
