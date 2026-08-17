import crypto from 'node:crypto';

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const errorId = crypto.randomUUID();
  const clientError = Number.isInteger(err.status) && err.status >= 400 && err.status < 500;
  const status = clientError ? err.status : 500;
  console.error(`[${errorId}]`, err);
  if (process.env.NODE_ENV === 'production') {
    return res.status(status).json({
      error: clientError ? 'bad request' : 'server error',
      code: clientError ? 'bad_request' : 'internal_error',
      error_id: errorId,
    });
  }
  res.status(status).json({ error: err.message || 'server error', error_id: errorId });
}
