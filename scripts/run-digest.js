#!/usr/bin/env node
/**
 * Generates an AI review for a period and prints it.
 * Usage: npm run digest -- weekly     (daily | weekly | monthly)
 * Run it from cron, or let src/jobs/scheduler.js handle it in-process.
 */
import { generateDigest } from '../src/ai/digest.js';

const period = process.argv[2] || 'weekly';
const { body_md: body } = await generateDigest(period);
console.log(body);
