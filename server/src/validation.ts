import { z } from 'zod';

export const bboxSchema = z
  .object({
    south: z.number().min(-90).max(90),
    west: z.number().min(-180).max(180),
    north: z.number().min(-90).max(90),
    east: z.number().min(-180).max(180),
  })
  .refine((b) => b.south < b.north, { message: 'south must be less than north', path: ['south'] })
  .refine((b) => b.west < b.east, { message: 'west must be less than east (areas across the antimeridian are not supported)', path: ['west'] });

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address')).pipe(z.string().max(254)),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
});

/** Login does not re-check the password policy; a wrong password is just wrong. */
export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(200),
});

export const areaSchema = z.intersection(
  bboxSchema,
  z.object({
    name: z.string().trim().min(1, 'Give the area a name').max(80),
    /** Optional finished scan of this bbox, recorded as the first history row. */
    jobId: z.string().uuid().optional(),
  }),
);

export const rescanSchema = z.object({ force: z.boolean().optional() }).default({});

export const idParam = z.coerce.number().int().positive();
