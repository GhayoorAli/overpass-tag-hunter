import bcrypt from 'bcrypt';
import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import type { DB } from './db.js';
import { HttpError } from './errors.js';
import { credentialsSchema, loginSchema } from './validation.js';

export interface AuthUser {
  id: number;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export interface AuthOptions {
  secret: string;
  expiresIn: jwt.SignOptions['expiresIn'];
  rateLimit: number;
  bcryptRounds?: number;
}

export function signToken(user: AuthUser, opts: Pick<AuthOptions, 'secret' | 'expiresIn'>): string {
  return jwt.sign({ email: user.email }, opts.secret, { subject: String(user.id), expiresIn: opts.expiresIn });
}

function userFromHeader(header: string | undefined, secret: string): AuthUser | null {
  if (!header?.startsWith('Bearer ')) return null;
  try {
    const payload = jwt.verify(header.slice(7), secret) as jwt.JwtPayload;
    return { id: Number(payload.sub), email: String(payload.email) };
  } catch {
    return null;
  }
}

/** 401 unless a valid `Authorization: Bearer <token>` is present; sets `req.user`. */
export function requireAuth(secret: string): RequestHandler {
  return (req, _res, next) => {
    const user = userFromHeader(req.headers.authorization, secret);
    if (!user) return next(new HttpError(401, 'Log in to use saved areas.', 'unauthorized'));
    req.user = user;
    next();
  };
}

/** Sets `req.user` when a valid token is present, otherwise continues anonymously. */
export function optionalAuth(secret: string): RequestHandler {
  return (req, _res, next) => {
    req.user = userFromHeader(req.headers.authorization, secret) ?? undefined;
    next();
  };
}

export function authRouter(db: DB, opts: AuthOptions) {
  const router = Router();
  const rounds = opts.bcryptRounds ?? 12;

  router.use(
    rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: opts.rateLimit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'rate_limited', message: 'Too many login attempts. Try again in a few minutes.' },
    }),
  );

  const findUser = db.prepare<[string], { id: number; email: string; password_hash: string }>(
    'SELECT id, email, password_hash FROM users WHERE email = ?',
  );
  const insertUser = db.prepare<[string, string]>('INSERT INTO users (email, password_hash) VALUES (?, ?)');

  router.post('/register', async (req, res) => {
    const { email, password } = credentialsSchema.parse(req.body);
    if (findUser.get(email)) throw new HttpError(409, 'An account with this email already exists.', 'email_taken');
    const hash = await bcrypt.hash(password, rounds);
    const info = insertUser.run(email, hash);
    const user = { id: Number(info.lastInsertRowid), email };
    res.status(201).json({ token: signToken(user, opts), user });
  });

  router.post('/login', async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const row = findUser.get(email);
    // Compare against a dummy hash when the user is missing to keep timing similar.
    const ok = await bcrypt.compare(password, row?.password_hash ?? '$2b$12$C6UzMDM.H6dfI/f/IKcEeO5Q8rN7x5ZyQyVb7xg1n0x9mE4aZ0Gm6');
    if (!row || !ok) throw new HttpError(401, 'Wrong email or password.', 'invalid_credentials');
    const user = { id: row.id, email: row.email };
    res.json({ token: signToken(user, opts), user });
  });

  router.get('/me', requireAuth(opts.secret), (req, res) => {
    res.json({ user: req.user });
  });

  return router;
}
