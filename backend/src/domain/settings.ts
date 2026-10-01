import { z } from 'zod';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm');

/** Hotel settings (spec section 4). Every level has defaults, so a partial object is completed on parse. */
export const SettingsSchema = z
  .object({
    legal: z
      .object({
        restPeriodMinHours: z.number().min(0).max(24).default(11),
        limitMode: z.enum(['daily', 'weekly']).default('daily'),
        dailyMaxHours: z.number().positive().max(24).default(10),
        weeklyMaxHours: z.number().positive().max(168).default(48),
        breakRules: z
          .array(z.object({ grossOverHours: z.number().min(0), minMinutes: z.number().int().min(0) }))
          .default([
            { grossOverHours: 6, minMinutes: 30 },
            { grossOverHours: 9, minMinutes: 45 },
          ]),
        minors: z
          .object({
            enforcement: z.enum(['warn', 'block']).default('warn'),
            requireOverrideReason: z.boolean().default(true),
            maxDailyHours: z.number().positive().default(8),
            maxWeeklyHours: z.number().positive().default(40),
            maxDaysPerWeek: z.number().int().min(1).max(7).default(5),
            maxShiftSpanHours: z.number().positive().default(11),
            minRestHours: z.number().min(0).default(12),
            earliestStart: hhmm.default('06:00'),
            latestEnd: hhmm.default('20:00'),
            latestEndHospitality16Plus: hhmm.default('22:00'),
            breakRules: z
              .array(z.object({ workingOverHours: z.number().min(0), minMinutes: z.number().int().min(0) }))
              .default([
                { workingOverHours: 4.5, minMinutes: 30 },
                { workingOverHours: 6, minMinutes: 60 },
              ]),
          })
          .default({}),
      })
      .default({}),
    roster: z
      .object({
        changeNoticeHours: z.number().min(0).default(72),
        belowTargetOnAssign: z.boolean().default(false),
        maxShiftsPerDay: z.number().int().min(1).max(6).default(2),
        maxDaySpanHours: z.number().positive().default(12),
      })
      .default({}),
    portal: z
      .object({
        planVisibility: z.enum(['own_departments', 'whole_hotel', 'own_only']).default('own_departments'),
        nameFormat: z.enum(['first_last_initial', 'full']).default('first_last_initial'),
      })
      .default({}),
    wishes: z.object({ minLeadDays: z.number().int().min(0).nullable().default(null) }).default({}),
    attendance: z
      .object({
        breakMode: z.enum(['auto', 'recorded']).default('auto'),
        earlyClockInMinutes: z.number().int().min(0).default(30),
        lateToleranceMinutes: z.number().int().min(0).default(5),
        overtimeToleranceMinutes: z.number().int().min(0).default(15),
        needsReviewAfterHours: z.number().positive().default(14),
        kioskAllowedIps: z.array(z.string()).default([]),
        pinMaxAttempts: z.number().int().min(1).default(5),
        pinLockMinutes: z.number().int().min(1).default(15),
      })
      .default({}),
    absence: z
      .object({
        sickNoteRequiredFromDay: z.number().int().min(1).default(4),
        sickCreditMaxDays: z.number().int().min(0).default(42),
      })
      .default({}),
    payroll: z
      .object({
        nightFrom: hhmm.default('23:00'),
        nightTo: hhmm.default('06:00'),
        datev: z
          .object({
            product: z.enum(['lodas', 'lug']).nullable().default(null),
            consultantNumber: z.string().nullable().default(null),
            clientNumber: z.string().nullable().default(null),
            encoding: z.string().default('windows-1252'),
            headerTemplate: z.string().default(''),
            recordDescriptionTemplate: z.string().default(''),
            lineTemplate: z.string().default(''),
            wageTypes: z
              .object({
                worked: z.string().nullable().default(null),
                annualLeave: z.string().nullable().default(null),
                sick: z.string().nullable().default(null),
                school: z.string().nullable().default(null),
                night: z.string().nullable().default(null),
                sunday: z.string().nullable().default(null),
                holiday: z.string().nullable().default(null),
              })
              .default({}),
          })
          .default({}),
      })
      .default({}),
    retention: z
      .object({
        timeRecordsYears: z.number().int().min(1).default(3),
        inquiriesMonths: z.number().int().min(1).default(24),
      })
      .default({}),
  })
  .strict();

export type HotelSettings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: HotelSettings = SettingsSchema.parse({});

/** Effective settings: stored (possibly partial / older) JSON completed with defaults. */
export function effectiveSettings(stored: unknown): HotelSettings {
  const parsed = SettingsSchema.safeParse(stored ?? {});
  if (parsed.success) return parsed.data;
  // Stored settings are written through the validated PUT; fall back to defaults if something odd is stored.
  return DEFAULT_SETTINGS;
}
