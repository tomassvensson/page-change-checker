import { z } from 'zod';

import { captureFields, ruleSchema } from './rules.js';

const ms = z.number().int().min(1).max(300000),
  hour = z.number().int().min(0).max(23);
const targetSchema = z.strictObject({
  ...captureFields,
  id: z.string().min(1),
  label: z.string().min(1),
  url: z.url().refine((value) => {
    const u = new URL(value);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password;
  }, 'Only HTTP(S) URLs without embedded credentials are permitted'),
  rules: z.array(ruleSchema).min(1),
  enabled: z.boolean().optional(),
  bootstrapSite: z.string().optional(),
  browserChannel: z.string().optional(),
  profileDirectoryName: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  maxTitleLength: z.number().int().positive().optional(),
  settleMs: ms.optional(),
  changeConfirmationWaitMs: ms.optional(),
  authenticationRequired: z.boolean().optional(),
  authCheck: z
    .strictObject({
      loggedOutTextContains: z.array(z.string()).optional(),
      loggedOutUrlContains: z.array(z.string()).optional(),
      requiredUrlContains: z.array(z.string()).optional(),
      requiredSelector: z.string().optional()
    })
    .optional(),
  checkSchedule: z
    .strictObject({ frequency: z.literal('daily'), afterHour: hour.optional() })
    .optional(),
  httpRetry: z
    .strictObject({
      maxAttempts: z.number().int().min(1).max(5),
      retryDelayMs: ms,
      timeoutMs: ms.optional(),
      statuses: z.array(z.number().int().min(400).max(599)).optional()
    })
    .optional(),
  autoLogin: z
    .strictObject({
      credentialFile: z.string().min(1),
      usernameSelector: z.string().min(1),
      passwordSelector: z.string().min(1),
      submitSelector: z.string().min(1),
      timeoutMs: ms.optional(),
      maxAttempts: z.number().int().min(1).max(5).optional(),
      retryDelayMs: ms.optional(),
      loggedOutTextContains: z.array(z.string()).optional()
    })
    .optional(),
  progress: z
    .strictObject({
      xpLabel: z.string(),
      streakLabel: z.string(),
      activitySelector: z.string().optional(),
      activityResponseUrlContains: z.string().min(1).optional(),
      activityDatePath: z.string().min(1).optional(),
      activityTimeZone: z.string().optional(),
      activityAttribute: z.string().optional(),
      activeValues: z.array(z.string()).optional(),
      inactiveValues: z.array(z.string()).optional()
    })
    .optional()
});

export const monitorSettingsSchema = z
  .strictObject({
    heartbeatUrl: z
      .url()
      .refine((url) => new URL(url).protocol === 'https:')
      .optional(),
    intervalMinutes: z.number().int().min(5).max(1440),
    maximumRunMinutes: z.number().int().min(5).max(120).optional(),
    headless: z.boolean(),
    navigationTimeoutMs: ms.optional(),
    defaultSettleMs: ms.optional(),
    requiredElementTimeoutMs: ms.optional(),
    loginBootstrapTimeoutMinutes: z.number().int().min(1).max(60).optional(),
    changeConfirmationWaitMs: ms.optional(),
    openReportOnNotification: z.boolean().optional(),
    notifyOnWarnings: z.boolean().optional(),
    maxArchivedReports: z.number().int().positive().optional(),
    screenshotMaxAgeDays: z.number().int().positive().optional(),
    evidenceMaxAgeDays: z.number().int().positive().optional(),
    localReportUrl: z.url().optional(),
    duolingoProgressHistory: z
      .strictObject({
        enabled: z.boolean(),
        host: z.enum(['localhost', '127.0.0.1', '::1']),
        port: z.number().int().min(1).max(65535),
        database: z.string().min(1),
        username: z.string().min(1),
        psqlPath: z.string().min(1),
        connectTimeoutSeconds: z.number().int().min(1).max(30),
        activeTargetIds: z.array(z.string())
      })
      .optional(),
    dailyEmail: z
      .strictObject({
        enabled: z.boolean(),
        sendOnNewEvents: z.boolean().optional(),
        sendAfterHour: hour,
        from: z.email(),
        to: z.array(z.email()).min(1),
        subjectPrefix: z.string().min(1),
        senderName: z.string().optional(),
        smtp: z.strictObject({
          host: z.string().min(1),
          port: z.number().int().min(1).max(65535),
          secure: z.boolean(),
          credentialFile: z.string().min(1)
        })
      })
      .optional(),
    targets: z.array(targetSchema).min(1)
  })
  .superRefine((settings, ctx) => {
    const targets = new Set<string>();
    for (const [index, target] of settings.targets.entries()) {
      if (targets.has(target.id))
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate target ID',
          path: ['targets', index, 'id']
        });
      targets.add(target.id);
      const rules = new Set<string>();
      for (const [i, rule] of target.rules.entries()) {
        if (rules.has(rule.id))
          ctx.addIssue({
            code: 'custom',
            message: 'Duplicate rule ID',
            path: ['targets', index, 'rules', i, 'id']
          });
        rules.add(rule.id);
      }
    }
    for (const id of settings.duolingoProgressHistory?.activeTargetIds ?? [])
      if (!targets.has(id))
        ctx.addIssue({
          code: 'custom',
          message: 'History target does not exist',
          path: ['duolingoProgressHistory', 'activeTargetIds']
        });
  });
export type MonitorSettings = z.infer<typeof monitorSettingsSchema>;
export type MonitorTarget = MonitorSettings['targets'][number];
