import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { config } from './config.js';

export const connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
export const sendQueue = new Queue('send', {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: 1000,
  },
});
export const enqueueMessages = (ids, delays = []) =>
  sendQueue.addBulk(ids.map((id, i) => ({ name: 'send', data: { messageId: id }, opts: { jobId: id, ...(delays[i] > 0 && { delay: delays[i] }) } })));
