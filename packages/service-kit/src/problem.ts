import type { FastifyReply } from 'fastify';

/** An error answered as an RFC 9457 problem document, with its HTTP status. */
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail ?? title);
    this.name = 'ProblemError';
  }
}

export const badRequest = (detail?: string, extra?: Record<string, unknown>) =>
  new ProblemError(400, 'Bad Request', detail, extra);
export const unauthorized = () => new ProblemError(401, 'Unauthorized');
export const forbidden = (detail?: string) => new ProblemError(403, 'Forbidden', detail);
/** Also the answer for a resource that belongs to someone else: its existence is not disclosed. */
export const notFound = (detail?: string) => new ProblemError(404, 'Not Found', detail);
export const conflict = (detail?: string, extra?: Record<string, unknown>) =>
  new ProblemError(409, 'Conflict', detail, extra);

export function sendProblem(
  reply: FastifyReply,
  status: number,
  title: string,
  extra: Record<string, unknown> = {},
): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ type: 'about:blank', title, status, ...extra });
}
