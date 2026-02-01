/**
 * Global Batch Status API (Privacy-Preserving)
 *
 * PRIVACY: This endpoint only stores an anonymous count and timestamp.
 * No deposit IDs, amounts, or identifying information is stored.
 *
 * In production, this should be:
 * 1. Hosted inside a TEE (MagicBlock PER)
 * 2. Or replaced with an on-chain counter PDA
 */

import { NextResponse } from 'next/server';

// Privacy-preserving batch state - only stores count + window start time
// NO deposit IDs, amounts, or any identifying information
const globalBatchState = {
  count: 0,                        // Anonymous count only
  windowStart: Date.now(),         // When current batch window started
  batchThreshold: 3,
  batchWindowMs: 10 * 60 * 1000,   // 10 minutes
  lastSettledAt: 0,                // When last batch was settled
  settledBatches: 0,               // Total batches settled
};

// Reset batch window if expired
function checkBatchWindow() {
  const now = Date.now();
  if (now - globalBatchState.windowStart > globalBatchState.batchWindowMs) {
    // Window expired, reset count
    globalBatchState.count = 0;
    globalBatchState.windowStart = now;
  }
}

// GET - Get current batch status (anonymous count only)
export async function GET() {
  checkBatchWindow();

  const totalCount = globalBatchState.count;
  const batchNumber = Math.floor(totalCount / globalBatchState.batchThreshold);
  let pendingCount = totalCount % globalBatchState.batchThreshold;

  // Show "just settled" state for 5 seconds after a batch completes
  const settleDisplayDuration = 5000; // 5 seconds
  const timeSinceSettle = Date.now() - globalBatchState.lastSettledAt;
  const showingSettled = globalBatchState.lastSettledAt > 0 && timeSinceSettle < settleDisplayDuration;

  // If we just settled, show 3/3 and "Settled" state
  if (showingSettled && pendingCount === 0) {
    pendingCount = globalBatchState.batchThreshold;
  }

  const elapsed = Date.now() - globalBatchState.windowStart;
  const timeRemaining = Math.max(0, globalBatchState.batchWindowMs - elapsed);

  // Return only anonymous aggregate data
  return NextResponse.json({
    pendingCount,
    batchThreshold: globalBatchState.batchThreshold,
    estimatedSettleTime: showingSettled ? 0 : timeRemaining,
    isReady: pendingCount >= globalBatchState.batchThreshold,
    justSettled: showingSettled,
    settledBatches: globalBatchState.settledBatches,
    // Note: No deposit IDs, amounts, or timestamps exposed
  });
}

// POST - Increment anonymous counter (no identifying data stored)
export async function POST() {
  checkBatchWindow();

  const prevCount = globalBatchState.count;
  globalBatchState.count++;
  const newCount = globalBatchState.count;

  // Check if this deposit completed a batch
  const prevBatch = Math.floor(prevCount / globalBatchState.batchThreshold);
  const newBatch = Math.floor(newCount / globalBatchState.batchThreshold);

  if (newBatch > prevBatch) {
    // Batch just completed!
    globalBatchState.lastSettledAt = Date.now();
    globalBatchState.settledBatches = newBatch;
    console.log('[BatchAPI] Batch #' + newBatch + ' completed!');
  }

  const pendingCount = newCount % globalBatchState.batchThreshold;

  console.log('[BatchAPI] Anonymous increment, count:', newCount, 'pending:', pendingCount);

  return NextResponse.json({
    success: true,
    pendingCount: pendingCount === 0 && newBatch > prevBatch ? globalBatchState.batchThreshold : pendingCount,
    batchThreshold: globalBatchState.batchThreshold,
    justSettled: newBatch > prevBatch,
    batchNumber: newBatch,
  });
}
