export class HttpError extends Error {
  constructor(status, message, code, data) {
    super(message);
    this.status = status;
    this.code = code ?? status;
    this.data = data;
  }
}

export const badRequest = (message) => new HttpError(400, message, 'bad_request');
export const unauthorized = (message = 'Authentication required') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message = 'You do not have permission to do this') => new HttpError(403, message, 'forbidden');
export const notFound = (what = 'Resource') => new HttpError(404, `${what} not found`, 'not_found');
export const conflict = (message, code = 'conflict') => new HttpError(409, message, code);
export const unprocessable = (message, code = 'unprocessable', data) => new HttpError(422, message, code, data);
