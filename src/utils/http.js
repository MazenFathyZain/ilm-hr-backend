// Every response uses the envelope the Flutter app already models:
// { status, message, data } on success and { status, message, code } on error.
export function ok(res, data, message = 'OK', status = 200) {
  res.status(status).json({ status, message, data });
}

export function created(res, data, message = 'Created') {
  ok(res, data, message, 201);
}

// Express 5 forwards rejected promises to the error handler, so handlers can be async directly.
