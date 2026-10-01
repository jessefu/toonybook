import { and, desc, eq, isNull } from 'drizzle-orm';

import { db } from '@/core/db';
import { aiTask } from '@/config/db/schema';
import { consume, revoke } from '@/modules/credits/service';
import { getUuid } from '@/lib/hash';

export enum AITaskStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  SUCCESS = 'success',
  FAILED = 'failed',
  CANCELED = 'canceled',
}

/**
 * Create an AI task with optional credit consumption.
 */
export async function createTask(params: {
  userId: string;
  mediaType: string;
  provider: string;
  model: string;
  prompt: string;
  costCredits?: number;
  options?: any;
}): Promise<any> {
  const { userId, mediaType, provider, model, prompt, costCredits, options } =
    params;

  return db().transaction(async (tx: any) => {
    // 1. Insert task
    const taskData: any = {
      id: getUuid(),
      userId,
      mediaType,
      provider,
      model,
      prompt,
      status: AITaskStatus.PENDING,
      costCredits: costCredits || 0,
      options: options ? JSON.stringify(options) : null,
    };

    const [task] = await tx.insert(aiTask).values(taskData).returning();

    // 2. Consume credits if cost > 0
    if (costCredits && costCredits > 0) {
      const result = await consume({
        userId,
        credits: costCredits,
        scene: 'ai_task',
        description: `AI ${mediaType} generation`,
        metadata: JSON.stringify({ taskId: task.id }),
        tx,
      });

      if (!result.success) {
        throw new Error('Insufficient credits');
      }

      // Store consumed credit ID for potential revocation
      if (result.consumedCredit) {
        await tx
          .update(aiTask)
          .set({ creditId: result.consumedCredit.id })
          .where(eq(aiTask.id, task.id));
        task.creditId = result.consumedCredit.id;
      }
    }

    return task;
  });
}

/**
 * Update task status. Revokes credits on failure.
 */
export async function updateTask(params: {
  taskId: string;
  status: AITaskStatus;
  taskResult?: any;
}) {
  const { taskId, status, taskResult } = params;

  const [task] = await db()
    .select()
    .from(aiTask)
    .where(eq(aiTask.id, taskId))
    .limit(1);

  if (!task) throw new Error('Task not found');

  // Update task
  const updateData: any = { status };
  if (taskResult) {
    updateData.taskResult = JSON.stringify(taskResult);
  }

  await db().update(aiTask).set(updateData).where(eq(aiTask.id, taskId));

  // Revoke credits on failure. `revoke()` is idempotent (it only matches a
  // still-ACTIVE consume record), so a repeated FAILED update is harmless.
  if (status === AITaskStatus.FAILED) {
    const creditId = task.creditId || readLegacyCreditId(task.taskInfo);
    if (creditId) {
      try {
        await revoke(creditId);
      } catch {
        // Ignore — a failed refund must not mask the original failure.
      }
    }
  }
}

/** Credit IDs used to live inside the taskInfo JSON blob; still read for old rows. */
function readLegacyCreditId(taskInfo: unknown): string | null {
  if (!taskInfo) return null;
  try {
    const info = typeof taskInfo === 'string' ? JSON.parse(taskInfo) : taskInfo;
    return info?.creditId || null;
  } catch {
    return null;
  }
}

/**
 * Shallow-merge a patch into the task's `taskInfo` JSON blob.
 *
 * Used by async pipelines to record progress between polls without clobbering
 * unrelated keys.
 */
export async function updateTaskInfo(
  taskId: string,
  patch: Record<string, any>
): Promise<Record<string, any>> {
  const [task] = await db()
    .select()
    .from(aiTask)
    .where(eq(aiTask.id, taskId))
    .limit(1);

  if (!task) throw new Error('Task not found');

  let current: Record<string, any> = {};
  if (task.taskInfo) {
    try {
      current =
        typeof task.taskInfo === 'string'
          ? JSON.parse(task.taskInfo)
          : (task.taskInfo as Record<string, any>);
    } catch {
      current = {};
    }
  }

  const next = { ...current, ...patch };
  await db()
    .update(aiTask)
    .set({ taskInfo: JSON.stringify(next) })
    .where(eq(aiTask.id, taskId));

  return next;
}

/**
 * Get tasks for a user.
 */
export async function getTasks(params: {
  userId: string;
  mediaType?: string;
  status?: string;
  page?: number;
  limit?: number;
}) {
  const { userId, mediaType, status, page = 1, limit = 20 } = params;

  return db()
    .select()
    .from(aiTask)
    .where(
      and(
        eq(aiTask.userId, userId),
        mediaType ? eq(aiTask.mediaType, mediaType) : undefined,
        status ? eq(aiTask.status, status) : undefined,
        isNull(aiTask.deletedAt)
      )
    )
    .orderBy(desc(aiTask.createdAt))
    .limit(limit)
    .offset((page - 1) * limit);
}

/**
 * Find task by ID.
 */
export async function findTask(taskId: string) {
  const [result] = await db()
    .select()
    .from(aiTask)
    .where(eq(aiTask.id, taskId))
    .limit(1);
  return result;
}
